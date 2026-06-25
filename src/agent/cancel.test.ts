/**
 * No-auto-cancel surface tests (issue #12; CONTEXT.md → Kill switch / control surface).
 * The settled rule (ADR-aligned, do not re-introduce): the app NEVER auto-cancels a placed
 * order — a half-successful bot return is worse than none. Instead it surfaces the order + a
 * manual cancel link. `cancelSurfaceFor` is a pure, read-only projection of an order; these
 * tests pin the title-safe link choice and assert it touches nothing.
 */
import { describe, it, expect } from "vitest";
import { makeTempStore } from "@/store/test-helpers";
import { cancelSurfaceFor, AMAZON_ORDERS_URL, DISCOGS_PURCHASES_URL } from "./cancel";
import type { OrderRow } from "@/store/types";

function orderedRow(source: "discogs" | "amazon"): OrderRow {
  return {
    id: 7,
    run_id: 1,
    album_key: "secret|record",
    artist: "Secret",
    title: "Hidden Until Arrival",
    lane: "stretch",
    intent: "gap_fill",
    why: "spoiler",
    source,
    listing_url: "https://listing.example/the-secret-record",
    quoted_price_pence: 2650,
    final_price_pence: 2650,
    discogs_release_id: null,
    discogs_instance_id: null,
    discogs_logged_at: null,
    status: "ORDERED",
    created_at: "2026-06-24T12:00:00.000Z",
    approved_at: "2026-06-24T12:00:00.000Z",
    ordered_at: "2026-06-24T12:00:00.000Z",
    arrived_at: null,
    updated_at: "2026-06-24T12:00:00.000Z",
  };
}

describe("cancelSurfaceFor", () => {
  it("links an Amazon order to the account order-history page (not the listing)", () => {
    const surface = cancelSurfaceFor(orderedRow("amazon"));
    expect(surface.orderId).toBe(7);
    expect(surface.source).toBe("amazon");
    expect(surface.manageOrdersUrl).toBe(AMAZON_ORDERS_URL);
  });

  it("links a Discogs order to the buyer purchases page (not the listing)", () => {
    const surface = cancelSurfaceFor(orderedRow("discogs"));
    expect(surface.source).toBe("discogs");
    expect(surface.manageOrdersUrl).toBe(DISCOGS_PURCHASES_URL);
  });

  it("keeps the surprise: the link never carries the listing URL or the title", () => {
    // Pre-arrival the title is still hidden (CONTEXT.md → Reveal). The cancel link must be an
    // account-level page, so surfacing it can't spoil the record by leaking the listing URL.
    for (const source of ["amazon", "discogs"] as const) {
      const order = orderedRow(source);
      const surface = cancelSurfaceFor(order);
      expect(surface.manageOrdersUrl).not.toContain(order.listing_url);
      expect(surface.manageOrdersUrl.toLowerCase()).not.toContain("hidden");
    }
  });

  it("is read-only: surfacing a cancel link never mutates the order", () => {
    const { store, cleanup } = makeTempStore();
    try {
      const order = store.orders.propose({
        album_key: "x|y",
        artist: "X",
        title: "Y",
        intent: "gap_fill",
        source: "amazon",
        listing_url: "https://a/x",
        quoted_price_pence: 2000,
      });
      const ordered = store.orders.setStatus(order.id, "ORDERED", { final_price_pence: 2000 });

      cancelSurfaceFor(ordered);

      // The app offers a *link*, never an action: the order stays exactly ORDERED.
      expect(store.orders.get(order.id)!.status).toBe("ORDERED");
    } finally {
      cleanup();
    }
  });
});
