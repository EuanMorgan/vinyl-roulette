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

    it("lastScheduledAt reports the newest scheduled run's start, ignoring manual runs", () => {
      const t = makeTempStore(); // fixed clock → deterministic started_at
      cleanup = t.cleanup;
      expect(t.store.runs.lastScheduledAt()).toBeNull(); // none yet → catch-up guard sees never-run

      const scheduled = t.store.runs.create("scheduled");
      expect(t.store.runs.lastScheduledAt()).toBe(scheduled.started_at);

      // A later *manual* run (e.g. "Run now") must not move the monthly clock.
      t.store.runs.create("manual");
      expect(t.store.runs.lastScheduledAt()).toBe(scheduled.started_at);
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

    it("clears a rating back to no-signal (null), not a low score", () => {
      const t = makeTempStore();
      cleanup = t.cleanup;
      const key = albumKey("Various", "Bargain Bin Classics");
      t.store.ratings.set(key, "Various", "Bargain Bin Classics", 3);
      expect(t.store.ratings.get(key)?.rating).toBe(3);
      t.store.ratings.clear(key);
      expect(t.store.ratings.get(key)).toBeUndefined();
      // clearing a never-rated album is a no-op, not an error
      expect(() => t.store.ratings.clear(albumKey("Nobody", "Nothing"))).not.toThrow();
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

  // The picker-facing taste signal: one row per owned album, annotated with its rating
  // and notes. This is where "ownership is not endorsement" becomes consumable — an owned
  // album with no rating is NOT a positive example, so the picker must be able to tell a
  // loved record (5) from a tolerated one (2) from one carrying no signal at all (null).
  describe("collection.withTaste (picker taste signal)", () => {
    function seed(store: ReturnType<typeof makeTempStore>["store"]) {
      const abbey = albumKey("The Beatles", "Abbey Road");
      const dummy = albumKey("Portishead", "Dummy");
      const bin = albumKey("Various", "Now That's What I Call Music 12");
      store.collection.upsert([
        {
          album_key: abbey,
          artist: "The Beatles",
          title: "Abbey Road",
          year: 1969,
          discogs_instance_id: 1,
          genres: ["Rock"],
          styles: ["Pop Rock"],
        },
        {
          album_key: dummy,
          artist: "Portishead",
          title: "Dummy",
          discogs_instance_id: 2,
          genres: ["Electronic"],
          styles: ["Trip Hop"],
        },
        {
          album_key: bin,
          artist: "Various",
          title: "Now That's What I Call Music 12",
          discogs_instance_id: 3,
        },
      ]);
      return { abbey, dummy, bin };
    }

    it("returns one row per album with rating, notes, and parsed tags", () => {
      const t = makeTempStore();
      cleanup = t.cleanup;
      const { abbey, dummy } = seed(t.store);
      t.store.ratings.set(abbey, "The Beatles", "Abbey Road", 5);
      t.store.ratings.set(dummy, "Portishead", "Dummy", 2);
      t.store.notes.add(dummy, "Portishead", "Dummy", "gateway into trip-hop for me");
      t.store.notes.add(dummy, "Portishead", "Dummy", "this pressing sounds thin");

      const taste = t.store.collection.withTaste();
      const byKey = new Map(taste.map((r) => [r.album_key, r]));

      const loved = byKey.get(abbey)!;
      expect(loved.rating).toBe(5);
      expect(loved.genres).toEqual(["Rock"]);
      expect(loved.styles).toEqual(["Pop Rock"]);
      expect(loved.notes).toEqual([]);

      const tolerated = byKey.get(dummy)!;
      expect(tolerated.rating).toBe(2);
      // notes preserved verbatim, oldest-first, for the Brain to reason over
      expect(tolerated.notes).toEqual([
        "gateway into trip-hop for me",
        "this pressing sounds thin",
      ]);
    });

    it("reports an owned-but-unrated album as rating null (ownership is not endorsement)", () => {
      const t = makeTempStore();
      cleanup = t.cleanup;
      const { bin } = seed(t.store);
      const row = t.store.collection.withTaste().find((r) => r.album_key === bin)!;
      expect(row.rating).toBeNull();
      expect(row.notes).toEqual([]);
      // a bargain-bin pick must be distinguishable from a loved one: null !== a number
      expect(typeof row.rating).not.toBe("number");
    });

    it("collapses multiple pressings of the same album into one taste row", () => {
      const t = makeTempStore();
      cleanup = t.cleanup;
      const key = albumKey("The Beatles", "Abbey Road");
      t.store.collection.upsert([
        { album_key: key, artist: "The Beatles", title: "Abbey Road", discogs_instance_id: 10 },
        { album_key: key, artist: "The Beatles", title: "Abbey Road", discogs_instance_id: 11 },
      ]);
      t.store.ratings.set(key, "The Beatles", "Abbey Road", 4);
      const rows = t.store.collection.withTaste().filter((r) => r.album_key === key);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.rating).toBe(4);
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

    it("derives a priciest-first Splurge wishlist, one row per album with a price", () => {
      const t = makeTempStore();
      cleanup = t.cleanup;
      const cheap = albumKey("Wings", "Band on the Run");
      const pricey = albumKey("John Coltrane", "A Love Supreme");
      t.store.rejected.add({ album_key: cheap, artist: "Wings", title: "Band on the Run", reason: "over_budget", quoted_price_pence: 2500 });
      // Same album rejected twice; the wishlist collapses to one row at the higher quote.
      t.store.rejected.add({ album_key: pricey, artist: "John Coltrane", title: "A Love Supreme", reason: "over_budget", quoted_price_pence: 4500 });
      t.store.rejected.add({ album_key: pricey, artist: "John Coltrane", title: "A Love Supreme", reason: "over_budget", quoted_price_pence: 5200 });
      // No price → can't be sized against the chest → excluded from the wishlist.
      t.store.rejected.add({ album_key: albumKey("Lost", "Sold Out"), artist: "Lost", title: "Sold Out", reason: "out_of_stock" });

      const wishlist = t.store.rejected.splurgeWishlist();
      expect(wishlist.map((w) => w.title)).toEqual(["A Love Supreme", "Band on the Run"]);
      expect(wishlist[0]?.quoted_price_pence).toBe(5200);
    });

    it("clears every Rejected-log row for an album when a Splurge lands it", () => {
      const t = makeTempStore();
      cleanup = t.cleanup;
      const key = albumKey("John Coltrane", "A Love Supreme");
      t.store.rejected.add({ album_key: key, artist: "John Coltrane", title: "A Love Supreme", reason: "over_budget", quoted_price_pence: 4500 });
      t.store.rejected.add({ album_key: key, artist: "John Coltrane", title: "A Love Supreme", reason: "over_budget", quoted_price_pence: 5200 });
      expect(t.store.rejected.clearAlbum(key)).toBe(2);
      expect(t.store.rejected.hasAlbum(key)).toBe(false);
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

    it("recordDiscogsLog stamps the arrival write-back (release + instance + time)", () => {
      const t = makeTempStore();
      cleanup = t.cleanup;
      // An Amazon buy: no release id known at order time (the write-back confirms it).
      const order = t.store.orders.propose({
        album_key: albumKey("Curtis Mayfield", "Super Fly"),
        artist: "Curtis Mayfield",
        title: "Super Fly",
        lane: "adjacent",
        intent: "gap_fill",
        source: "amazon",
        listing_url: "https://amazon.example/superfly",
        quoted_price_pence: 2899,
      });
      expect(order.discogs_release_id).toBeNull();
      expect(order.discogs_instance_id).toBeNull();
      expect(order.discogs_logged_at).toBeNull();

      const logged = t.store.orders.recordDiscogsLog(order.id, 555, 9001);
      expect(logged.discogs_release_id).toBe(555); // confirmed release patched on
      expect(logged.discogs_instance_id).toBe(9001); // the "already logged" marker
      expect(logged.discogs_logged_at).not.toBeNull();
    });
  });

  describe("owned set (collection ∪ purchase ledger)", () => {
    it("unions the synced library with bought orders, album-level", () => {
      const t = makeTempStore();
      cleanup = t.cleanup;

      const synced = albumKey("The Beatles", "Abbey Road");
      t.store.collection.upsert([
        { album_key: synced, artist: "The Beatles", title: "Abbey Road", discogs_instance_id: 1 },
      ]);

      // An order only counts as owned once it reaches ORDERED (payment cleared).
      const bought = albumKey("Wings", "Band on the Run");
      const order = t.store.orders.propose({
        album_key: bought,
        artist: "Wings",
        title: "Band on the Run",
        intent: "gap_fill",
        source: "amazon",
        listing_url: "https://amazon.example/x",
        quoted_price_pence: 2500,
      });

      // PROPOSED is not yet owned — nothing has been bought.
      expect(t.store.owned.has(bought)).toBe(false);
      expect(t.store.collection.ownsAlbum(bought)).toBe(false);

      t.store.orders.setStatus(order.id, "ORDERED", { final_price_pence: 2500 });

      expect(t.store.owned.has(synced)).toBe(true); // from the library
      expect(t.store.owned.has(bought)).toBe(true); // from the ledger
      expect(t.store.owned.has(albumKey("Pixies", "Doolittle"))).toBe(false);

      // collection.ownsAlbum stays library-only; owned.has is the union.
      expect(t.store.collection.ownsAlbum(bought)).toBe(false);

      expect(new Set(t.store.owned.keys())).toEqual(new Set([synced, bought]));
    });

    it("does not count declined or stale orders as owned", () => {
      const t = makeTempStore();
      cleanup = t.cleanup;
      const key = albumKey("Radiohead", "Kid A");
      const order = t.store.orders.propose({
        album_key: key,
        artist: "Radiohead",
        title: "Kid A",
        intent: "gap_fill",
        source: "discogs",
        listing_url: "https://discogs.example/y",
        quoted_price_pence: 3000,
      });
      t.store.orders.setStatus(order.id, "DECLINED");
      expect(t.store.owned.has(key)).toBe(false);
      expect(t.store.owned.keys()).toEqual([]);
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

    it("accrues the monthly cap once per Run, carrying over unspent funds", () => {
      const t = makeTempStore();
      cleanup = t.cleanup;
      const run1 = t.store.runs.create("scheduled");
      const run2 = t.store.runs.create("scheduled");

      const first = t.store.ledger.accrueCap(run1.id, 3000);
      expect(first?.balance_after_pence).toBe(3000);
      // Idempotent: a second accrual for the same Run is a no-op, never inflating the chest.
      expect(t.store.ledger.accrueCap(run1.id, 3000)).toBeNull();
      expect(t.store.ledger.balance()).toBe(3000);

      // A fresh Run accrues again; the previous month's unspent £30 carries over to £60.
      const second = t.store.ledger.accrueCap(run2.id, 3000);
      expect(second?.balance_after_pence).toBe(6000);
    });

    it("activity merges money movements with quote/approval/order lifecycle events", () => {
      const t = makeTempStore();
      cleanup = t.cleanup;
      const run = t.store.runs.create("scheduled");
      t.store.ledger.accrueCap(run.id, 3000); // cap_added (a money event)
      const order = t.store.orders.propose({
        album_key: albumKey("The Beatles", "Let It Be"),
        artist: "The Beatles",
        title: "Let It Be",
        intent: "gap_fill",
        source: "discogs",
        listing_url: "https://d/letitbe",
        quoted_price_pence: 2000,
      });
      t.store.orders.setStatus(order.id, "APPROVED");
      t.store.orders.setStatus(order.id, "ORDERED", { final_price_pence: 2000 });
      t.store.ledger.append({ entry_type: "order_placed", amount_pence: -2000, order_id: order.id });

      const kinds = t.store.ledger.activity().map((e) => e.kind);
      // Every quote, approval, and order (the spend) is surfaced, alongside the cap accrual.
      expect(kinds).toContain("quote");
      expect(kinds).toContain("approved");
      expect(kinds).toContain("cap_added");
      expect(kinds).toContain("order_placed");
      // Money events carry the running balance; lifecycle events carry the source, not the title.
      const capEvent = t.store.ledger.activity().find((e) => e.kind === "cap_added");
      expect(capEvent?.balanceAfterPence).toBe(3000);
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
