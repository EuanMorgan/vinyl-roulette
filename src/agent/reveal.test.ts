/**
 * Reveal + Discogs write-back seam tests (issue #10). The surprise (which record) isn't the
 * subject; the *rules around the arrival tap* are — what the Reveal surfaces, and that the
 * write-back is one-tap for a Discogs buy, confirm-a-best-guess for an Amazon buy, idempotent,
 * and only ever fires on an ARRIVED order. Everything runs against a real temp DB with the
 * Discogs adapter faked at its boundary: no network.
 */
import { describe, it, expect } from "vitest";
import { FakeDiscogsAdapter } from "@/adapters/fakes";
import { makeTempStore } from "@/store/test-helpers";
import type { Store } from "@/store/store";
import { albumKey, type OrderStatus, type Source } from "@/store/types";
import { buildReveal, logArrivalToDiscogs } from "./reveal";

interface OrderOpts {
  artist?: string;
  title?: string;
  source?: Source;
  discogsReleaseId?: number | null;
  status?: OrderStatus;
}

/** Park a quote and walk it to a chosen status (default ARRIVED) for the Reveal to act on. */
function makeOrder(store: Store, opts: OrderOpts = {}) {
  const artist = opts.artist ?? "Alice Coltrane";
  const title = opts.title ?? "Journey in Satchidananda";
  const order = store.orders.propose({
    album_key: albumKey(artist, title),
    artist,
    title,
    lane: "stretch",
    intent: "gap_fill",
    why: "a canonical spiritual-jazz on-ramp",
    source: opts.source ?? "discogs",
    listing_url: "https://d/jis",
    quoted_price_pence: 2650,
    discogs_release_id: opts.discogsReleaseId ?? null,
  });
  const target = opts.status ?? "ARRIVED";
  if (target === "PROPOSED") return order;
  store.orders.setStatus(order.id, "APPROVED");
  store.orders.setStatus(order.id, "ORDERED", { final_price_pence: 2650 });
  if (target === "ORDERED") return store.orders.get(order.id)!;
  return store.orders.setStatus(order.id, "ARRIVED");
}

describe("reveal", () => {
  it("surfaces what / why / how-it-fits, not just a title", async () => {
    const { store, cleanup } = makeTempStore();
    try {
      const order = makeOrder(store, { discogsReleaseId: 42 });
      const view = await buildReveal(store, order);

      expect(view.artist).toBe("Alice Coltrane");
      expect(view.title).toBe("Journey in Satchidananda");
      expect(view.lane).toBe("stretch"); // how it fits
      expect(view.why).toContain("on-ramp"); // why it was picked
      expect(view.pricePence).toBe(2650);
      expect(view.source).toBe("discogs");
    } finally {
      cleanup();
    }
  });

  it("carries the album's rating + notes so feedback is one tap away", async () => {
    const { store, cleanup } = makeTempStore();
    try {
      const order = makeOrder(store, { discogsReleaseId: 42 });
      store.ratings.set(order.album_key, order.artist, order.title, 4);
      store.notes.add(order.album_key, order.artist, order.title, "side B is the one");

      const view = await buildReveal(store, order);
      expect(view.rating).toBe(4);
      expect(view.notes).toEqual(["side B is the one"]);
    } finally {
      cleanup();
    }
  });

  it("Discogs-sourced buy: release id known → ready for a one-tap add, then logs idempotently", async () => {
    const { store, cleanup } = makeTempStore();
    try {
      const discogs = new FakeDiscogsAdapter();
      const order = makeOrder(store, { source: "discogs", discogsReleaseId: 42 });

      const view = await buildReveal(store, order, { discogs });
      expect(view.discogs.kind).toBe("ready");
      if (view.discogs.kind === "ready") expect(view.discogs.releaseId).toBe(42);

      const result = await logArrivalToDiscogs(store, { discogs }, order.id);
      expect(result.outcome).toBe("logged");
      expect(discogs.added).toEqual([42]);

      const logged = store.orders.get(order.id)!;
      expect(logged.discogs_instance_id).not.toBeNull();
      expect(logged.discogs_logged_at).not.toBeNull();

      // The Reveal now reads as logged…
      const after = await buildReveal(store, logged, { discogs });
      expect(after.discogs.kind).toBe("logged");

      // …and a re-tap adds nothing more (idempotent).
      const again = await logArrivalToDiscogs(store, { discogs }, order.id);
      expect(again.outcome).toBe("already_logged");
      expect(discogs.added).toEqual([42]);
    } finally {
      cleanup();
    }
  });

  it("Amazon-sourced buy: no release id → pre-fills best guesses; confirming one logs it", async () => {
    const { store, cleanup } = makeTempStore();
    try {
      const discogs = new FakeDiscogsAdapter();
      discogs.setSearchResults("Curtis Mayfield", "Super Fly", [
        { releaseId: 555, artist: "Curtis Mayfield", title: "Super Fly", year: 1972 },
        { releaseId: 556, artist: "Curtis Mayfield", title: "Super Fly (Reissue)", year: 2018 },
      ]);
      const order = makeOrder(store, {
        artist: "Curtis Mayfield",
        title: "Super Fly",
        source: "amazon",
        discogsReleaseId: null,
      });

      const view = await buildReveal(store, order, { discogs });
      expect(view.discogs.kind).toBe("needs_match");
      if (view.discogs.kind === "needs_match") {
        expect(view.discogs.suggestions.map((s) => s.releaseId)).toEqual([555, 556]);
      }

      // Without a confirmed release there is nothing to add.
      const noPick = await logArrivalToDiscogs(store, { discogs }, order.id);
      expect(noPick.outcome).toBe("no_release");
      expect(discogs.added).toEqual([]);

      // Euan confirms the best guess → that exact release is added and patched onto the order.
      const result = await logArrivalToDiscogs(store, { discogs }, order.id, 555);
      expect(result.outcome).toBe("logged");
      expect(discogs.added).toEqual([555]);
      expect(store.orders.get(order.id)!.discogs_release_id).toBe(555);
    } finally {
      cleanup();
    }
  });

  it("needs_match degrades to an empty shortlist when the Discogs search fails", async () => {
    const { store, cleanup } = makeTempStore();
    try {
      const flaky: import("@/adapters/types").DiscogsAdapter = {
        async fetchCollection() {
          return [];
        },
        async searchReleases() {
          throw new Error("discogs down");
        },
        async addToCollection() {
          return { instanceId: 1 };
        },
      };
      const order = makeOrder(store, { source: "amazon", discogsReleaseId: null });
      const view = await buildReveal(store, order, { discogs: flaky });
      expect(view.discogs.kind).toBe("needs_match");
      if (view.discogs.kind === "needs_match") expect(view.discogs.suggestions).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("guards: only an ARRIVED order is logged (title-on-arrival rule)", async () => {
    const { store, cleanup } = makeTempStore();
    try {
      const discogs = new FakeDiscogsAdapter();
      const ordered = makeOrder(store, { discogsReleaseId: 42, status: "ORDERED" });

      const result = await logArrivalToDiscogs(store, { discogs }, ordered.id);
      expect(result.outcome).toBe("not_arrived");
      expect(discogs.added).toEqual([]);
      expect(store.orders.get(ordered.id)!.discogs_instance_id).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("reports failure (and stays un-logged) when the Discogs write throws", async () => {
    const { store, cleanup } = makeTempStore();
    try {
      const discogs = new FakeDiscogsAdapter();
      discogs.failAdd(42);
      const order = makeOrder(store, { discogsReleaseId: 42 });

      const result = await logArrivalToDiscogs(store, { discogs }, order.id);
      expect(result.outcome).toBe("failed");
      if (result.outcome === "failed") expect(result.error).toContain("42");
      // Un-logged, so the tap can be retried once Discogs recovers.
      expect(store.orders.get(order.id)!.discogs_instance_id).toBeNull();
    } finally {
      cleanup();
    }
  });
});
