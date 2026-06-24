import { describe, it, expect, afterEach } from "vitest";
import { makeTempStore } from "./test-helpers";
import { albumKey, DEFAULT_CONFIG } from "./types";

describe("Store", () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  describe("runs", () => {
    it("creates, reads, finishes, and lists runs (the E2E spine row)", () => {
      const t = makeTempStore();
      cleanup = t.cleanup;
      const run = t.store.runs.create("manual");
      expect(run.id).toBeGreaterThan(0);
      expect(run.status).toBe("started");
      expect(run.finished_at).toBeNull();

      const finished = t.store.runs.finish(run.id, "finished", "wrote a row");
      expect(finished.status).toBe("finished");
      expect(finished.summary).toBe("wrote a row");
      expect(finished.finished_at).not.toBeNull();

      expect(t.store.runs.list().map((r) => r.id)).toContain(run.id);
    });
  });

  describe("collection (album-level ownership)", () => {
    it("upserts idempotently by instance id and answers ownsAlbum", () => {
      const t = makeTempStore();
      cleanup = t.cleanup;
      const key = albumKey("The Beatles", "Abbey Road");
      const row = {
        album_key: key,
        artist: "The Beatles",
        title: "Abbey Road",
        discogs_instance_id: 111,
        genres: ["Rock"],
      };
      t.store.collection.upsert([row]);
      t.store.collection.upsert([{ ...row, title: "Abbey Road (Remaster)" }]); // same instance
      expect(t.store.collection.all()).toHaveLength(1);
      expect(t.store.collection.ownsAlbum(key)).toBe(true);
      expect(t.store.collection.ownsAlbum(albumKey("Wings", "Band on the Run"))).toBe(false);
    });

    it("matches album identity ignoring case/punctuation/accents", () => {
      expect(albumKey("Sigur Rós", "( )")).toBe(albumKey("sigur ros", "()"));
      expect(albumKey("The Beatles", "Let It Be")).toBe(albumKey("THE BEATLES", "let it be"));
    });
  });

  describe("ratings & notes (ownership is not endorsement)", () => {
    it("round-trips a rating with upsert semantics", () => {
      const t = makeTempStore();
      cleanup = t.cleanup;
      const key = albumKey("Miles Davis", "Kind of Blue");
      t.store.ratings.set(key, "Miles Davis", "Kind of Blue", 4);
      expect(t.store.ratings.get(key)?.rating).toBe(4);
      t.store.ratings.set(key, "Miles Davis", "Kind of Blue", 5);
      expect(t.store.ratings.get(key)?.rating).toBe(5);
      expect(t.store.ratings.all()).toHaveLength(1);
    });

    it("appends multiple notes for one album", () => {
      const t = makeTempStore();
      cleanup = t.cleanup;
      const key = albumKey("Portishead", "Dummy");
      t.store.notes.add(key, "Portishead", "Dummy", "gateway into trip-hop for me");
      t.store.notes.add(key, "Portishead", "Dummy", "this pressing sounds thin");
      const notes = t.store.notes.listFor(key);
      expect(notes.map((n) => n.body)).toEqual([
        "gateway into trip-hop for me",
        "this pressing sounds thin",
      ]);
    });
  });

  describe("rejected log (don't re-suggest + splurge wishlist)", () => {
    it("records a rejection and reports hasAlbum", () => {
      const t = makeTempStore();
      cleanup = t.cleanup;
      const key = albumKey("John Coltrane", "A Love Supreme");
      t.store.rejected.add({
        album_key: key,
        artist: "John Coltrane",
        title: "A Love Supreme",
        lane: "stretch",
        reason: "over_budget",
        quoted_price_pence: 4500,
      });
      expect(t.store.rejected.hasAlbum(key)).toBe(true);
      expect(t.store.rejected.all()[0]?.reason).toBe("over_budget");
    });
  });

  describe("orders (lifecycle)", () => {
    it("proposes a quote and drives PROPOSED → APPROVED → ORDERED → ARRIVED with stamps", () => {
      const t = makeTempStore();
      cleanup = t.cleanup;
      const order = t.store.orders.propose({
        album_key: albumKey("The Beatles", "Let It Be"),
        artist: "The Beatles",
        title: "Let It Be",
        lane: "complete",
        intent: "gap_fill",
        source: "discogs",
        listing_url: "https://discogs.example/listing/1",
        quoted_price_pence: 2200,
      });
      expect(order.status).toBe("PROPOSED");
      expect(order.approved_at).toBeNull();

      const approved = t.store.orders.setStatus(order.id, "APPROVED");
      expect(approved.approved_at).not.toBeNull();

      const ordered = t.store.orders.setStatus(order.id, "ORDERED", { final_price_pence: 2250 });
      expect(ordered.ordered_at).not.toBeNull();
      expect(ordered.final_price_pence).toBe(2250);

      const arrived = t.store.orders.setStatus(order.id, "ARRIVED");
      expect(arrived.arrived_at).not.toBeNull();

      expect(t.store.orders.listByStatus("ARRIVED").map((o) => o.id)).toContain(order.id);
    });
  });

  describe("ledger / balance (war chest)", () => {
    it("accumulates a signed running balance across entries", () => {
      const t = makeTempStore();
      cleanup = t.cleanup;
      expect(t.store.ledger.balance()).toBe(0);

      const cap1 = t.store.ledger.append({ entry_type: "cap_added", amount_pence: 3000 });
      expect(cap1.balance_after_pence).toBe(3000);

      const cap2 = t.store.ledger.append({ entry_type: "cap_added", amount_pence: 3000 });
      expect(cap2.balance_after_pence).toBe(6000);

      const spend = t.store.ledger.append({ entry_type: "order_placed", amount_pence: -2200 });
      expect(spend.balance_after_pence).toBe(3800);
      expect(t.store.ledger.balance()).toBe(3800);
    });
  });

  describe("config (typed key/value)", () => {
    it("returns defaults when unset", () => {
      const t = makeTempStore();
      cleanup = t.cleanup;
      expect(t.store.config.get()).toEqual(DEFAULT_CONFIG);
      expect(t.store.config.isPaused()).toBe(false);
    });

    it("persists a partial patch and merges over defaults", () => {
      const t = makeTempStore();
      cleanup = t.cleanup;
      t.store.config.set({ paused: true, monthlyCapPence: 5000 });
      const cfg = t.store.config.get();
      expect(cfg.paused).toBe(true);
      expect(cfg.monthlyCapPence).toBe(5000);
      // untouched field keeps its default
      expect(cfg.priceDriftTolerancePence).toBe(DEFAULT_CONFIG.priceDriftTolerancePence);
    });
  });
});
