/**
 * Order-lifecycle seam tests (PRD → Testing Decisions; issue #7). The chaos (which record)
 * is never asserted; the *rules around* it are — the deterministic transitions and the STALE
 * escape hatch. Everything runs against a real temp DB with the Brain/pricing/buy/notify
 * adapters faked at their boundaries: no network, no browser.
 */
import { describe, it, expect } from "vitest";
import {
  FakeBrainAdapter,
  FakeBuyAdapter,
  FakeNotificationAdapter,
  FakePricingAdapter,
} from "@/adapters/fakes";
import type { BrainCandidate, BuyAdapter, PriceListing, PricingAdapter } from "@/adapters/types";
import { makeTempStore } from "@/store/test-helpers";
import type { Store } from "@/store/store";
import { runGapFill } from "./run";
import { approveOrder, declineOrder, markArrived, type ApproveDeps } from "./lifecycle";

function avail(source: "discogs" | "amazon", pence: number, url: string): PriceListing {
  return { source, listingUrl: url, landedPricePence: pence, available: true };
}

function fund(store: Store, pence: number): void {
  store.ledger.append({ entry_type: "cap_added", amount_pence: pence, note: "test" });
}

/** Build approval deps; the buy + notifier fakes are returned so tests can read them back. */
function makeDeps(
  candidates: BrainCandidate[],
  prices: Record<string, PriceListing[]>,
  seed = 1,
): { deps: ApproveDeps; pricing: FakePricingAdapter; buy: FakeBuyAdapter; notifier: FakeNotificationAdapter } {
  const brain = new FakeBrainAdapter(candidates);
  const pricing = new FakePricingAdapter();
  for (const [k, listings] of Object.entries(prices)) {
    const [artist = "", title = ""] = k.split("::");
    pricing.setListings(artist, title, listings);
  }
  const buy = new FakeBuyAdapter();
  const notifier = new FakeNotificationAdapter();
  return { deps: { brain, pricing, buy, notifier, seed }, pricing, buy, notifier };
}

const JIS: BrainCandidate = {
  artist: "Alice Coltrane",
  title: "Journey in Satchidananda",
  lane: "stretch",
  why: "jazz on-ramp",
};
const JIS_URL = "https://d/jis";

describe("order lifecycle", () => {
  it("drives a PROPOSED quote through APPROVED → ORDERED → ARRIVED on the happy path", async () => {
    const { store, cleanup } = makeTempStore();
    try {
      fund(store, 5000);
      const { deps, buy } = makeDeps([JIS], {
        "Alice Coltrane::Journey in Satchidananda": [avail("discogs", 2650, JIS_URL)],
      });

      const prep = await runGapFill(store, deps, "scheduled");
      const orderId = prep!.order!.id;

      const result = await approveOrder(store, deps, orderId);
      expect(result.outcome).toBe("ordered");
      // The Hands were driven exactly once each, to the re-validated quote.
      expect(buy.prepared).toHaveLength(1);
      expect(buy.paid).toHaveLength(1);
      expect(buy.paid[0]).toMatchObject({ source: "discogs", expectedPricePence: 2650 });

      const ordered = store.orders.get(orderId)!;
      expect(ordered.status).toBe("ORDERED");
      expect(ordered.final_price_pence).toBe(2650);
      expect(ordered.approved_at).not.toBeNull();
      expect(ordered.ordered_at).not.toBeNull();

      // Money left the war chest: a negative order_placed entry, balance now 5000 - 2650.
      expect(store.ledger.balance()).toBe(5000 - 2650);
      const spend = store.ledger.list().find((e) => e.entry_type === "order_placed")!;
      expect(spend).toMatchObject({ amount_pence: -2650, order_id: orderId });

      const arrived = markArrived(store, orderId)!;
      expect(arrived.status).toBe("ARRIVED");
      expect(arrived.arrived_at).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  it("fires a title-free PROPOSED notification (price + source only)", async () => {
    const { store, cleanup } = makeTempStore();
    try {
      fund(store, 5000);
      const { deps, notifier } = makeDeps([JIS], {
        "Alice Coltrane::Journey in Satchidananda": [avail("discogs", 2650, JIS_URL)],
      });

      const prep = await runGapFill(store, deps, "scheduled");

      expect(notifier.sent).toHaveLength(1);
      expect(notifier.sent[0]).toEqual({
        orderId: prep!.order!.id,
        source: "discogs",
        pricePence: 2650,
      });
      // The surprise survives: no title leaks into the nudge payload.
      expect(Object.keys(notifier.sent[0]!)).not.toContain("title");
      expect(JSON.stringify(notifier.sent[0])).not.toContain("Journey");
    } finally {
      cleanup();
    }
  });

  it("buys at the re-validated price when it drifts up within tolerance (£2 < £3)", async () => {
    const { store, cleanup } = makeTempStore();
    try {
      fund(store, 5000);
      const { deps, pricing, buy } = makeDeps([JIS], {
        "Alice Coltrane::Journey in Satchidananda": [avail("discogs", 2650, JIS_URL)],
      });
      const prep = await runGapFill(store, deps, "scheduled");
      pricing.setDriftedPrice(JIS_URL, 2850); // +£2 over quote

      const result = await approveOrder(store, deps, prep!.order!.id);
      expect(result.outcome).toBe("ordered");
      expect(buy.paid[0]?.expectedPricePence).toBe(2850);
      expect(store.orders.get(prep!.order!.id)!.final_price_pence).toBe(2850);
    } finally {
      cleanup();
    }
  });

  it("buys cheaper when the price dropped (a drop is never stale)", async () => {
    const { store, cleanup } = makeTempStore();
    try {
      fund(store, 5000);
      const { deps, pricing } = makeDeps([JIS], {
        "Alice Coltrane::Journey in Satchidananda": [avail("discogs", 2650, JIS_URL)],
      });
      const prep = await runGapFill(store, deps, "scheduled");
      pricing.setDriftedPrice(JIS_URL, 2400); // dropped

      const result = await approveOrder(store, deps, prep!.order!.id);
      expect(result.outcome).toBe("ordered");
      expect(store.orders.get(prep!.order!.id)!.final_price_pence).toBe(2400);
    } finally {
      cleanup();
    }
  });

  it("marks STALE and re-picks a different record when the price drifts past tolerance", async () => {
    const { store, cleanup } = makeTempStore();
    try {
      fund(store, 5000);
      const second: BrainCandidate = { artist: "Pharoah Sanders", title: "Karma", lane: "stretch", why: "next jazz step" };
      const { deps, pricing, buy, notifier } = makeDeps([JIS, second], {
        "Alice Coltrane::Journey in Satchidananda": [avail("discogs", 2650, JIS_URL)],
        "Pharoah Sanders::Karma": [avail("discogs", 2700, "https://d/karma")],
      });
      const prep = await runGapFill(store, deps, "scheduled");
      const firstId = prep!.order!.id;
      pricing.setDriftedPrice(JIS_URL, 3051); // +£4.01 over quote → past the £3 tolerance

      const result = await approveOrder(store, deps, firstId);

      expect(result.outcome).toBe("stale");
      // Never silently swapped: the approved order stays STALE, a *new* PROPOSED is written.
      expect(store.orders.get(firstId)!.status).toBe("STALE");
      if (result.outcome === "stale") {
        const reproposed = result.reproposed!.order!;
        expect(reproposed.id).not.toBe(firstId);
        expect(reproposed.title).toBe("Karma");
        expect(reproposed.status).toBe("PROPOSED");
      }
      // The stale album is logged to Rejected so it isn't re-picked or re-suggested.
      expect(store.rejected.all().some((r) => r.title === "Journey in Satchidananda" && r.reason === "stale")).toBe(true);
      // No payment was attempted; Euan was re-notified for the new quote.
      expect(buy.paid).toHaveLength(0);
      expect(notifier.sent).toHaveLength(2);
      expect(notifier.sent[1]?.pricePence).toBe(2700);
    } finally {
      cleanup();
    }
  });

  it("marks STALE and re-picks when the listing is gone", async () => {
    const { store, cleanup } = makeTempStore();
    try {
      fund(store, 5000);
      const second: BrainCandidate = { artist: "Pharoah Sanders", title: "Karma", lane: "stretch", why: "next jazz step" };
      const { deps, pricing, buy } = makeDeps([JIS, second], {
        "Alice Coltrane::Journey in Satchidananda": [avail("discogs", 2650, JIS_URL)],
        "Pharoah Sanders::Karma": [avail("discogs", 2700, "https://d/karma")],
      });
      const prep = await runGapFill(store, deps, "scheduled");
      const firstId = prep!.order!.id;
      pricing.markGone(JIS_URL); // one-of-one Discogs listing sold overnight

      const result = await approveOrder(store, deps, firstId);
      expect(result.outcome).toBe("stale");
      expect(store.orders.get(firstId)!.status).toBe("STALE");
      expect(buy.paid).toHaveLength(0);
      if (result.outcome === "stale") {
        expect(result.reproposed!.order!.title).toBe("Karma");
      }
    } finally {
      cleanup();
    }
  });

  it("marks FAILED (not re-picked) when payment does not complete after approval", async () => {
    const { store, cleanup } = makeTempStore();
    try {
      fund(store, 5000);
      const { deps, buy } = makeDeps([JIS], {
        "Alice Coltrane::Journey in Satchidananda": [avail("discogs", 2650, JIS_URL)],
      });
      const prep = await runGapFill(store, deps, "scheduled");
      buy.payError = "card declined";

      const result = await approveOrder(store, deps, prep!.order!.id);
      expect(result.outcome).toBe("failed");
      expect(store.orders.get(prep!.order!.id)!.status).toBe("FAILED");
      // No money recorded on a failed payment.
      expect(store.ledger.list().some((e) => e.entry_type === "order_placed")).toBe(false);
      expect(store.ledger.balance()).toBe(5000);
    } finally {
      cleanup();
    }
  });

  it("folds a thrown buy-adapter rejection into FAILED (never stuck APPROVED)", async () => {
    const { store, cleanup } = makeTempStore();
    try {
      fund(store, 5000);
      const { deps } = makeDeps([JIS], {
        "Alice Coltrane::Journey in Satchidananda": [avail("discogs", 2650, JIS_URL)],
      });
      const prep = await runGapFill(store, deps, "scheduled");
      // The real Playwright Hands can throw rather than return { ok: false }.
      const throwingBuy: BuyAdapter = {
        async prepare() {
          return { ready: true };
        },
        async pay() {
          throw new Error("browser crashed mid-checkout");
        },
      };

      const result = await approveOrder(store, { ...deps, buy: throwingBuy }, prep!.order!.id);
      expect(result.outcome).toBe("failed");
      if (result.outcome === "failed") expect(result.error).toContain("browser crashed");
      expect(store.orders.get(prep!.order!.id)!.status).toBe("FAILED");
      expect(store.ledger.list().some((e) => e.entry_type === "order_placed")).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("bails out as not_proposed if the order stops being PROPOSED during revalidation", async () => {
    const { store, cleanup } = makeTempStore();
    try {
      fund(store, 5000);
      const { deps, buy } = makeDeps([JIS], {
        "Alice Coltrane::Journey in Satchidananda": [avail("discogs", 2650, JIS_URL)],
      });
      const prep = await runGapFill(store, deps, "scheduled");
      const orderId = prep!.order!.id;
      // Simulate a concurrent approval landing during the async revalidate gap (a UI double-tap).
      const racingPricing: PricingAdapter = {
        lookup: (q) => deps.pricing.lookup(q),
        async revalidate(url) {
          store.orders.setStatus(orderId, "APPROVED");
          return deps.pricing.revalidate(url);
        },
      };

      const result = await approveOrder(store, { ...deps, pricing: racingPricing }, orderId);
      expect(result.outcome).toBe("not_proposed");
      // The second approval never drove the Hands — no double-buy.
      expect(buy.paid).toHaveLength(0);
      expect(buy.prepared).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("marks FAILED when Playwright can't drive to the payment button", async () => {
    const { store, cleanup } = makeTempStore();
    try {
      fund(store, 5000);
      const { deps, buy } = makeDeps([JIS], {
        "Alice Coltrane::Journey in Satchidananda": [avail("discogs", 2650, JIS_URL)],
      });
      const prep = await runGapFill(store, deps, "scheduled");
      buy.prepareError = "checkout page changed";

      const result = await approveOrder(store, deps, prep!.order!.id);
      expect(result.outcome).toBe("failed");
      expect(buy.paid).toHaveLength(0); // never reached payment
      expect(store.orders.get(prep!.order!.id)!.status).toBe("FAILED");
    } finally {
      cleanup();
    }
  });

  it("guards: approving an order that is not PROPOSED does nothing", async () => {
    const { store, cleanup } = makeTempStore();
    try {
      fund(store, 5000);
      const { deps, buy } = makeDeps([JIS], {
        "Alice Coltrane::Journey in Satchidananda": [avail("discogs", 2650, JIS_URL)],
      });
      const prep = await runGapFill(store, deps, "scheduled");
      const orderId = prep!.order!.id;
      await approveOrder(store, deps, orderId); // → ORDERED

      const again = await approveOrder(store, deps, orderId);
      expect(again.outcome).toBe("not_proposed");
      expect(buy.paid).toHaveLength(1); // not driven a second time
    } finally {
      cleanup();
    }
  });

  it("declines a PROPOSED order → DECLINED + Rejected log, no money moved", async () => {
    const { store, cleanup } = makeTempStore();
    try {
      fund(store, 5000);
      const { deps, buy } = makeDeps([JIS], {
        "Alice Coltrane::Journey in Satchidananda": [avail("discogs", 2650, JIS_URL)],
      });
      const prep = await runGapFill(store, deps, "scheduled");
      const orderId = prep!.order!.id;

      const result = declineOrder(store, orderId);
      expect(result.outcome).toBe("declined");
      expect(store.orders.get(orderId)!.status).toBe("DECLINED");

      // Goes to the Rejected log so it isn't re-suggested next Run (CONTEXT.md → Rejected log).
      const rejected = store.rejected.all();
      expect(
        rejected.some((r) => r.title === "Journey in Satchidananda" && r.reason === "declined"),
      ).toBe(true);

      // No money moved: no spend recorded, balance untouched, the Hands never driven.
      expect(store.ledger.list().some((e) => e.entry_type === "order_placed")).toBe(false);
      expect(store.ledger.balance()).toBe(5000);
      expect(buy.prepared).toHaveLength(0);
      expect(buy.paid).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("guards: declining an order that is not PROPOSED does nothing", async () => {
    const { store, cleanup } = makeTempStore();
    try {
      fund(store, 5000);
      const { deps } = makeDeps([JIS], {
        "Alice Coltrane::Journey in Satchidananda": [avail("discogs", 2650, JIS_URL)],
      });
      const prep = await runGapFill(store, deps, "scheduled");
      const orderId = prep!.order!.id;
      await approveOrder(store, deps, orderId); // → ORDERED

      const result = declineOrder(store, orderId);
      expect(result.outcome).toBe("not_proposed");
      expect(store.orders.get(orderId)!.status).toBe("ORDERED"); // unchanged
      expect(store.rejected.all().some((r) => r.reason === "declined")).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("markArrived only fires on an ORDERED record", async () => {
    const { store, cleanup } = makeTempStore();
    try {
      fund(store, 5000);
      const { deps } = makeDeps([JIS], {
        "Alice Coltrane::Journey in Satchidananda": [avail("discogs", 2650, JIS_URL)],
      });
      const prep = await runGapFill(store, deps, "scheduled");
      // Still PROPOSED — arrival is a no-op transition.
      const stillProposed = markArrived(store, prep!.order!.id)!;
      expect(stillProposed.status).toBe("PROPOSED");
    } finally {
      cleanup();
    }
  });

  it("never auto-cancels a placed order — ORDERED only ever moves on to ARRIVED", async () => {
    // The settled safety rule (issue #12 / CONTEXT.md → Kill switch): once payment has cleared the
    // app NEVER claws the order back. There is no cancel/return transition in the lifecycle at all;
    // the public moves on a placed order are Decline (a no-op once ORDERED) and Arrive. This pins
    // that an ORDERED record cannot be sent backwards or cancelled through any of them.
    const { store, cleanup } = makeTempStore();
    try {
      fund(store, 5000);
      const { deps, buy } = makeDeps([JIS], {
        "Alice Coltrane::Journey in Satchidananda": [avail("discogs", 2650, JIS_URL)],
      });
      const prep = await runGapFill(store, deps, "scheduled");
      const orderId = prep!.order!.id;
      await approveOrder(store, deps, orderId); // → ORDERED (payment cleared)
      expect(store.orders.get(orderId)!.status).toBe("ORDERED");

      // Decline is the only "stop" verb on an order; on a placed one it does nothing (no clawback).
      expect(declineOrder(store, orderId).outcome).toBe("not_proposed");
      // Re-approving is likewise inert — no second payment, no status change.
      expect((await approveOrder(store, deps, orderId)).outcome).toBe("not_proposed");
      expect(store.orders.get(orderId)!.status).toBe("ORDERED");
      expect(buy.paid).toHaveLength(1); // paid exactly once, never reversed

      // The only forward move a placed order has is arrival (the Reveal).
      expect(markArrived(store, orderId)!.status).toBe("ARRIVED");
    } finally {
      cleanup();
    }
  });
});
