/**
 * The Gap-fill Run orchestrator, tested through the store seam (PRD → Testing Decisions):
 * fake the Brain + pricing, drive a real temp DB, and assert on the rows written — the
 * PROPOSED Quote, the Rejected-log entries, the Pause short-circuit. The chaos (which
 * record) is never asserted; the rules around it are.
 */
import { describe, it, expect } from "vitest";
import { FakeBrainAdapter, FakePricingAdapter } from "@/adapters/fakes";
import type { BrainCandidate, PriceListing } from "@/adapters/types";
import { makeTempStore } from "@/store/test-helpers";
import { albumKey } from "@/store/types";
import { runGapFill, buildTaste, type GapFillDeps } from "./run";
import type { Store } from "@/store/store";

function avail(source: "discogs" | "amazon", pence: number, url: string): PriceListing {
  return { source, listingUrl: url, landedPricePence: pence, available: true };
}

/** Give the war chest a balance so picks can be landed. */
function fund(store: Store, pence: number): void {
  store.ledger.append({ entry_type: "cap_added", amount_pence: pence, note: "test" });
}

function deps(candidates: BrainCandidate[], prices: Record<string, PriceListing[]>, seed = 1): GapFillDeps {
  const brain = new FakeBrainAdapter(candidates);
  const pricing = new FakePricingAdapter();
  for (const [k, listings] of Object.entries(prices)) {
    const [artist = "", title = ""] = k.split("::");
    pricing.setListings(artist, title, listings);
  }
  return { brain, pricing, seed };
}

describe("runGapFill", () => {
  it("parks the landed pick as a PROPOSED order and finishes the Run", async () => {
    const { store, cleanup } = makeTempStore();
    try {
      fund(store, 3000);
      const outcome = await runGapFill(
        store,
        deps(
          [{ artist: "Alice Coltrane", title: "Journey in Satchidananda", lane: "stretch", why: "jazz on-ramp" }],
          { "Alice Coltrane::Journey in Satchidananda": [avail("discogs", 2650, "https://d/jis")] },
        ),
        "manual",
      );

      expect(outcome).not.toBeNull();
      const proposed = store.orders.listByStatus("PROPOSED");
      expect(proposed).toHaveLength(1);
      expect(proposed[0]).toMatchObject({
        title: "Journey in Satchidananda",
        intent: "gap_fill",
        status: "PROPOSED",
        source: "discogs",
        quoted_price_pence: 2650,
        why: "jazz on-ramp",
      });
      // the Run summary keeps the surprise: it never names the title
      const run = store.runs.get(outcome!.runId)!;
      expect(run.status).toBe("finished");
      expect(run.summary).not.toContain("Journey");
    } finally {
      cleanup();
    }
  });

  it("writes unaffordable picks to the Rejected log and proposes the affordable one", async () => {
    const { store, cleanup } = makeTempStore();
    try {
      fund(store, 3000);
      await runGapFill(
        store,
        deps(
          [
            { artist: "Rare", title: "Expensive", lane: "complete", why: "want most" },
            { artist: "Common", title: "Affordable", lane: "complete", why: "backup" },
          ],
          {
            "Rare::Expensive": [avail("discogs", 9000, "https://d/rare")],
            "Common::Affordable": [avail("discogs", 2000, "https://d/common")],
          },
        ),
        "scheduled",
      );

      const proposed = store.orders.listByStatus("PROPOSED");
      expect(proposed[0]?.title).toBe("Affordable");
      const rejects = store.rejected.all();
      expect(rejects).toHaveLength(1);
      expect(rejects[0]).toMatchObject({ title: "Expensive", reason: "over_budget", quoted_price_pence: 9000 });
    } finally {
      cleanup();
    }
  });

  it("never re-proposes an owned album (collection ∪ purchase ledger)", async () => {
    const { store, cleanup } = makeTempStore();
    try {
      fund(store, 5000);
      store.collection.upsert([
        { album_key: albumKey("The Beatles", "Abbey Road"), artist: "The Beatles", title: "Abbey Road", discogs_instance_id: 1 },
      ]);
      await runGapFill(
        store,
        deps(
          [
            { artist: "The Beatles", title: "Abbey Road", lane: "complete", why: "owned dupe" },
            { artist: "The Beatles", title: "Let It Be", lane: "complete", why: "completes set" },
          ],
          {
            "The Beatles::Abbey Road": [avail("discogs", 1500, "https://d/abbey")],
            "The Beatles::Let It Be": [avail("discogs", 2000, "https://d/letitbe")],
          },
        ),
        "manual",
      );
      const proposed = store.orders.listByStatus("PROPOSED");
      expect(proposed).toHaveLength(1);
      expect(proposed[0]?.title).toBe("Let It Be");
    } finally {
      cleanup();
    }
  });

  it("records nothing-affordable without a PROPOSED order when every pick is over budget", async () => {
    const { store, cleanup } = makeTempStore();
    try {
      fund(store, 1000);
      const outcome = await runGapFill(
        store,
        deps(
          [{ artist: "Pricey", title: "Out of Reach", lane: "stretch", why: "x" }],
          { "Pricey::Out of Reach": [avail("discogs", 9000, "https://d/x")] },
        ),
        "manual",
      );
      expect(store.orders.listByStatus("PROPOSED")).toHaveLength(0);
      expect(store.rejected.all()).toHaveLength(1);
      expect(outcome!.order).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("does not Run while Paused", async () => {
    const { store, cleanup } = makeTempStore();
    try {
      fund(store, 3000);
      store.config.set({ paused: true });
      const outcome = await runGapFill(
        store,
        deps(
          [{ artist: "Any", title: "Thing", lane: "complete", why: "x" }],
          { "Any::Thing": [avail("discogs", 2000, "https://d/x")] },
        ),
        "scheduled",
      );
      expect(outcome).toBeNull();
      expect(store.runs.list()).toHaveLength(0);
      expect(store.orders.listByStatus("PROPOSED")).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("buildTaste includes the app's own ORDERED purchases in the Owned set", async () => {
    const { store, cleanup } = makeTempStore();
    try {
      store.collection.upsert([
        { album_key: albumKey("Nas", "Illmatic"), artist: "Nas", title: "Illmatic", discogs_instance_id: 1, genres: ["Hip Hop"] },
      ]);
      const order = store.orders.propose({
        album_key: albumKey("Portishead", "Dummy"),
        artist: "Portishead",
        title: "Dummy",
        intent: "gap_fill",
        source: "discogs",
        listing_url: "https://d/dummy",
        quoted_price_pence: 2000,
      });
      store.orders.setStatus(order.id, "ORDERED");

      const taste = buildTaste(store, { complete: 1, adjacent: 0, stretch: 0 });
      const titles = taste.owned.map((o) => o.title);
      expect(titles).toContain("Illmatic");
      expect(titles).toContain("Dummy");
    } finally {
      cleanup();
    }
  });
});
