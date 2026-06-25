/**
 * The monthly Run orchestrator (issue #8), tested through the store seam: fake the Brain +
 * pricing, drive a real temp DB, and assert on the *money rules* around the chaos — the cap
 * accrues and carries over, a Splurge fires only when the chest can clear a Rejected-log item
 * under the ceiling, a landed Splurge clears that record off the log, and total spend never
 * exceeds allotted funds. Which record is picked (the chaos) is never asserted.
 */
import { describe, it, expect } from "vitest";
import {
  FakeBrainAdapter,
  FakeBuyAdapter,
  FakePricingAdapter,
} from "@/adapters/fakes";
import type { BrainCandidate, PriceListing } from "@/adapters/types";
import { makeTempStore } from "@/store/test-helpers";
import { albumKey } from "@/store/types";
import type { Store } from "@/store/store";
import { runMonthly, type GapFillDeps } from "./run";
import { approveOrder } from "./lifecycle";

function avail(source: "discogs" | "amazon", pence: number, url: string): PriceListing {
  return { source, listingUrl: url, landedPricePence: pence, available: true };
}

function deps(
  candidates: BrainCandidate[],
  prices: Record<string, PriceListing[]>,
  seed = 1,
): GapFillDeps {
  const brain = new FakeBrainAdapter(candidates);
  const pricing = new FakePricingAdapter();
  for (const [k, listings] of Object.entries(prices)) {
    const [artist = "", title = ""] = k.split("::");
    pricing.setListings(artist, title, listings);
  }
  return { brain, pricing, seed };
}

/** A pricey wanted-but-unaffordable record already on the Rejected log (the Splurge wishlist). */
function seedRejected(store: Store, artist: string, title: string, pricePence: number): void {
  store.rejected.add({
    album_key: albumKey(artist, title),
    artist,
    title,
    lane: "stretch",
    reason: "over_budget",
    quoted_price_pence: pricePence,
  });
}

describe("runMonthly — cap accrual", () => {
  it("accrues the monthly cap each Run and carries unspent funds across Runs", async () => {
    const { store, cleanup } = makeTempStore();
    try {
      store.config.set({ splurgeChancePercent: 0 }); // isolate accrual from Splurge
      const nothing = deps([], {});
      await runMonthly(store, nothing, "scheduled");
      expect(store.ledger.balance()).toBe(3000); // one cap accrued, nothing bought
      await runMonthly(store, nothing, "scheduled");
      expect(store.ledger.balance()).toBe(6000); // last month's £30 carried over
    } finally {
      cleanup();
    }
  });

  it("does not accrue or create a Run while Paused", async () => {
    const { store, cleanup } = makeTempStore();
    try {
      store.config.set({ paused: true });
      const outcome = await runMonthly(store, deps([], {}), "scheduled");
      expect(outcome).toBeNull();
      expect(store.runs.list()).toHaveLength(0);
      expect(store.ledger.balance()).toBe(0);
    } finally {
      cleanup();
    }
  });
});

describe("runMonthly — Splurge intent", () => {
  it("fires only when the chest can clear a Rejected-log item, clearing it off the log", async () => {
    const { store, cleanup } = makeTempStore();
    try {
      store.config.set({ splurgeChancePercent: 100 }); // force the occasional roll
      store.ledger.append({ entry_type: "cap_added", amount_pence: 5000, note: "war chest" });
      seedRejected(store, "John Coltrane", "A Love Supreme", 5200);

      const outcome = await runMonthly(
        store,
        deps(
          [{ artist: "Backup", title: "Gap Pick", lane: "complete", why: "fallback" }],
          {
            "John Coltrane::A Love Supreme": [avail("discogs", 4500, "https://d/als")],
            "Backup::Gap Pick": [avail("discogs", 1000, "https://d/gap")],
          },
        ),
        "scheduled",
      );

      expect(outcome?.intent).toBe("splurge");
      const proposed = store.orders.listByStatus("PROPOSED");
      expect(proposed).toHaveLength(1);
      expect(proposed[0]).toMatchObject({ intent: "splurge", source: "discogs", quoted_price_pence: 4500 });
      // The record once unaffordable is now a live order, cleared off the Rejected log.
      expect(store.rejected.hasAlbum(albumKey("John Coltrane", "A Love Supreme"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("falls back to Gap-fill when no Rejected item is affordable, leaving the log intact", async () => {
    const { store, cleanup } = makeTempStore();
    try {
      store.config.set({ splurgeChancePercent: 100 });
      seedRejected(store, "John Coltrane", "A Love Supreme", 9000); // still out of reach

      const outcome = await runMonthly(
        store,
        deps(
          [{ artist: "The Beatles", title: "Let It Be", lane: "complete", why: "completes set" }],
          {
            "John Coltrane::A Love Supreme": [avail("discogs", 9000, "https://d/als")],
            "The Beatles::Let It Be": [avail("discogs", 2000, "https://d/letitbe")],
          },
        ),
        "scheduled",
      );

      expect(outcome?.intent).toBe("gap_fill");
      expect(store.orders.listByStatus("PROPOSED")[0]).toMatchObject({ intent: "gap_fill", title: "Let It Be" });
      // The unaffordable reject stays on the log for a future, fatter chest.
      expect(store.rejected.hasAlbum(albumKey("John Coltrane", "A Love Supreme"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("never Splurges when the chance dial is 0, even with an affordable Rejected item", async () => {
    const { store, cleanup } = makeTempStore();
    try {
      store.config.set({ splurgeChancePercent: 0 });
      store.ledger.append({ entry_type: "cap_added", amount_pence: 5000, note: "war chest" });
      seedRejected(store, "John Coltrane", "A Love Supreme", 4500);

      const outcome = await runMonthly(
        store,
        deps(
          [{ artist: "The Beatles", title: "Let It Be", lane: "complete", why: "completes set" }],
          {
            "John Coltrane::A Love Supreme": [avail("discogs", 4500, "https://d/als")],
            "The Beatles::Let It Be": [avail("discogs", 2000, "https://d/letitbe")],
          },
        ),
        "scheduled",
      );
      expect(outcome?.intent).toBe("gap_fill");
    } finally {
      cleanup();
    }
  });
});

describe("runMonthly — total spend never exceeds allotted funds", () => {
  it("keeps the balance non-negative: spend is bounded by accrued caps", async () => {
    const { store, cleanup } = makeTempStore();
    try {
      store.config.set({ splurgeChancePercent: 0 });
      const buy = new FakeBuyAdapter();

      // Month 1: accrue £30, propose + pay a £20 pick → balance £10. Reuse the same deps so
      // the approval re-validation finds the live listing (gone → STALE otherwise).
      const m1Deps = deps(
        [{ artist: "Common", title: "Affordable", lane: "complete", why: "x" }],
        { "Common::Affordable": [avail("discogs", 2000, "https://d/c")] },
      );
      const m1 = await runMonthly(store, m1Deps, "scheduled");
      expect(m1?.order).toBeDefined();
      await approveOrder(store, { ...m1Deps, buy }, m1!.order!.id);
      expect(store.ledger.balance()).toBe(1000);
      expect(store.ledger.balance()).toBeGreaterThanOrEqual(0);

      // Month 2: accrue another £30 → £40 available; nothing bought yet.
      await runMonthly(
        store,
        deps(
          [{ artist: "Rare", title: "Too Dear", lane: "complete", why: "y" }],
          { "Rare::Too Dear": [avail("discogs", 9000, "https://d/r")] },
        ),
        "scheduled",
      );
      // Two caps accrued (£60), one £20 order placed → exactly £40, never overspent.
      expect(store.ledger.balance()).toBe(4000);
      expect(store.ledger.balance()).toBeGreaterThanOrEqual(0);
    } finally {
      cleanup();
    }
  });

  it("refuses to propose a pick the war chest can't afford, leaving the balance intact", async () => {
    const { store, cleanup } = makeTempStore();
    try {
      store.config.set({ splurgeChancePercent: 0 });
      // One cap accrues (£30); the only pick costs £90 — must not be proposed or overspent.
      const outcome = await runMonthly(
        store,
        deps(
          [{ artist: "Rare", title: "Too Dear", lane: "stretch", why: "out of reach" }],
          { "Rare::Too Dear": [avail("discogs", 9000, "https://d/r")] },
        ),
        "scheduled",
      );
      expect(outcome?.order).toBeUndefined();
      expect(store.orders.listByStatus("PROPOSED")).toHaveLength(0);
      // The accrued cap is untouched and never negative — nothing was bought beyond funds.
      expect(store.ledger.balance()).toBe(3000);
      expect(store.ledger.balance()).toBeGreaterThanOrEqual(0);
    } finally {
      cleanup();
    }
  });
});
