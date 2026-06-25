import type { DB } from "./db";
import { runMigrations } from "./migrate";
import {
  DEFAULT_CONFIG,
  type Config,
  type CollectionRow,
  type LedgerActivityEvent,
  type LedgerEntryType,
  type LedgerRow,
  type NoteRow,
  type OrderRow,
  type OrderStatus,
  type RatingRow,
  type RejectedRow,
  type RejectReason,
  type RunRow,
  type RunStatus,
  type RunTrigger,
  type Lane,
  type Source,
  type BuyIntent,
  type TasteRow,
  parseTags,
} from "./types";

/** Injectable clock so tests get deterministic timestamps. */
export type Clock = () => string;
const systemClock: Clock = () => new Date().toISOString();

export interface StoreOptions {
  clock?: Clock;
  /** Run migrations on construction (default true). */
  migrate?: boolean;
}

/**
 * The typed store: the single place both the agent and the UI read/write the spine.
 * Construct with an open `DB`. Repositories are grouped by table.
 */
export class Store {
  readonly db: DB;
  private readonly now: Clock;

  constructor(db: DB, opts: StoreOptions = {}) {
    this.db = db;
    this.now = opts.clock ?? systemClock;
    if (opts.migrate ?? true) runMigrations(db);
  }

  // ── runs ────────────────────────────────────────────────────────────────
  readonly runs = {
    create: (trigger: RunTrigger): RunRow => {
      const startedAt = this.now();
      const info = this.db
        .prepare("INSERT INTO runs (trigger, status, started_at) VALUES (?, 'started', ?)")
        .run(trigger, startedAt);
      return this.runs.get(Number(info.lastInsertRowid))!;
    },
    finish: (id: number, status: RunStatus, summary?: string): RunRow => {
      this.db
        .prepare("UPDATE runs SET status = ?, summary = ?, finished_at = ? WHERE id = ?")
        .run(status, summary ?? null, this.now(), id);
      return this.runs.get(id)!;
    },
    get: (id: number): RunRow | undefined =>
      this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined,
    list: (limit = 50): RunRow[] =>
      this.db
        .prepare("SELECT * FROM runs ORDER BY id DESC LIMIT ?")
        .all(limit) as RunRow[],
  };

  // ── collection ──────────────────────────────────────────────────────────
  readonly collection = {
    /** Idempotent upsert of synced library rows, keyed by discogs_instance_id. */
    upsert: (rows: CollectionInput[]): void => {
      const stmt = this.db.prepare(`
        INSERT INTO collection
          (album_key, artist, title, year, discogs_release_id, discogs_instance_id,
           genres, styles, date_added, synced_at)
        VALUES
          (@album_key, @artist, @title, @year, @discogs_release_id, @discogs_instance_id,
           @genres, @styles, @date_added, @synced_at)
        ON CONFLICT (discogs_instance_id) DO UPDATE SET
          album_key = excluded.album_key,
          artist = excluded.artist,
          title = excluded.title,
          year = excluded.year,
          discogs_release_id = excluded.discogs_release_id,
          genres = excluded.genres,
          styles = excluded.styles,
          date_added = excluded.date_added,
          synced_at = excluded.synced_at
      `);
      const syncedAt = this.now();
      const insertMany = this.db.transaction((items: CollectionInput[]) => {
        for (const r of items) {
          stmt.run({
            album_key: r.album_key,
            artist: r.artist,
            title: r.title,
            year: r.year ?? null,
            discogs_release_id: r.discogs_release_id ?? null,
            discogs_instance_id: r.discogs_instance_id ?? null,
            genres: r.genres ? JSON.stringify(r.genres) : null,
            styles: r.styles ? JSON.stringify(r.styles) : null,
            date_added: r.date_added ?? null,
            synced_at: r.synced_at ?? syncedAt,
          });
        }
      });
      insertMany(rows);
    },
    all: (): CollectionRow[] =>
      this.db.prepare("SELECT * FROM collection ORDER BY artist, title").all() as CollectionRow[],
    /**
     * The taste signal the picker reads: one row per owned *album* (pressings collapsed),
     * left-joined to its rating and notes. An unrated album yields `rating: null` — the
     * absence of a positive signal, not a low one (CONTEXT.md → "ownership is not
     * endorsement"). Notes come back verbatim, oldest-first.
     */
    withTaste: (): TasteRow[] => {
      const rows = this.db
        .prepare(
          `SELECT c.album_key                AS album_key,
                  MIN(c.artist)              AS artist,
                  MIN(c.title)               AS title,
                  MIN(c.year)                AS year,
                  MIN(c.genres)              AS genres,
                  MIN(c.styles)              AS styles,
                  r.rating                   AS rating
             FROM collection c
             LEFT JOIN ratings r ON r.album_key = c.album_key
            GROUP BY c.album_key
            ORDER BY artist, title`,
        )
        .all() as {
        album_key: string;
        artist: string;
        title: string;
        year: number | null;
        genres: string | null;
        styles: string | null;
        rating: number | null;
      }[];
      return rows.map((row) => ({
        album_key: row.album_key,
        artist: row.artist,
        title: row.title,
        year: row.year,
        genres: parseTags(row.genres),
        styles: parseTags(row.styles),
        rating: row.rating ?? null,
        notes: this.notes.listFor(row.album_key).map((n) => n.body),
      }));
    },
    /** Album-level ownership check against the *synced library only* (no ledger). */
    ownsAlbum: (albumKey: string): boolean =>
      this.db.prepare("SELECT 1 FROM collection WHERE album_key = ? LIMIT 1").get(albumKey) !==
      undefined,
  };

  // ── owned set (collection ∪ purchase ledger) ──────────────────────────────
  // CONTEXT.md → "Collection / Owned set": dupe-avoidance matches against the union of
  // the read-synced Discogs library AND the records the app has itself bought. A record
  // counts as bought once its order reaches ORDERED (payment cleared) — the app DB is
  // authoritative for its own purchases, Discogs for what Euan logged himself.
  readonly owned = {
    /** Album-level ownership across library + bought orders. */
    has: (albumKey: string): boolean =>
      this.db
        .prepare(
          `SELECT 1 WHERE EXISTS (SELECT 1 FROM collection WHERE album_key = @key)
                       OR EXISTS (SELECT 1 FROM orders
                                  WHERE album_key = @key AND status IN ('ORDERED', 'ARRIVED'))`,
        )
        .get({ key: albumKey }) !== undefined,
    /** Every owned album_key (deduped) — the set the picker excludes from candidates. */
    keys: (): string[] =>
      (
        this.db
          .prepare(
            `SELECT album_key FROM collection
             UNION
             SELECT album_key FROM orders WHERE status IN ('ORDERED', 'ARRIVED')`,
          )
          .all() as { album_key: string }[]
      ).map((r) => r.album_key),
  };

  // ── ratings ─────────────────────────────────────────────────────────────
  readonly ratings = {
    set: (albumKey: string, artist: string, title: string, rating: number): RatingRow => {
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO ratings (album_key, artist, title, rating, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (album_key) DO UPDATE SET
             rating = excluded.rating, title = excluded.title,
             artist = excluded.artist, updated_at = excluded.updated_at`,
        )
        .run(albumKey, artist, title, rating, now, now);
      return this.ratings.get(albumKey)!;
    },
    get: (albumKey: string): RatingRow | undefined =>
      this.db.prepare("SELECT * FROM ratings WHERE album_key = ?").get(albumKey) as
        | RatingRow
        | undefined,
    /** Remove a rating, returning the album to no-signal (null), not a low score
     *  (CONTEXT.md → "ownership is not endorsement"). No-op if it was never rated. */
    clear: (albumKey: string): void => {
      this.db.prepare("DELETE FROM ratings WHERE album_key = ?").run(albumKey);
    },
    all: (): RatingRow[] => this.db.prepare("SELECT * FROM ratings").all() as RatingRow[],
  };

  // ── notes (append-only) ───────────────────────────────────────────────────
  readonly notes = {
    add: (albumKey: string, artist: string, title: string, body: string): NoteRow => {
      const info = this.db
        .prepare(
          "INSERT INTO notes (album_key, artist, title, body, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(albumKey, artist, title, body, this.now());
      return this.db
        .prepare("SELECT * FROM notes WHERE id = ?")
        .get(Number(info.lastInsertRowid)) as NoteRow;
    },
    listFor: (albumKey: string): NoteRow[] =>
      this.db
        .prepare("SELECT * FROM notes WHERE album_key = ? ORDER BY id")
        .all(albumKey) as NoteRow[],
  };

  // ── rejected log ──────────────────────────────────────────────────────────
  readonly rejected = {
    add: (input: RejectedInput): RejectedRow => {
      const info = this.db
        .prepare(
          `INSERT INTO rejected_log
             (album_key, artist, title, lane, reason, source, listing_url,
              quoted_price_pence, run_id, created_at)
           VALUES (@album_key, @artist, @title, @lane, @reason, @source, @listing_url,
                   @quoted_price_pence, @run_id, @created_at)`,
        )
        .run({
          album_key: input.album_key,
          artist: input.artist,
          title: input.title,
          lane: input.lane ?? null,
          reason: input.reason,
          source: input.source ?? null,
          listing_url: input.listing_url ?? null,
          quoted_price_pence: input.quoted_price_pence ?? null,
          run_id: input.run_id ?? null,
          created_at: this.now(),
        });
      return this.db
        .prepare("SELECT * FROM rejected_log WHERE id = ?")
        .get(Number(info.lastInsertRowid)) as RejectedRow;
    },
    all: (): RejectedRow[] =>
      this.db.prepare("SELECT * FROM rejected_log ORDER BY id DESC").all() as RejectedRow[],
    /** Has the Brain already tried (and failed/declined) this album? */
    hasAlbum: (albumKey: string): boolean =>
      this.db.prepare("SELECT 1 FROM rejected_log WHERE album_key = ? LIMIT 1").get(albumKey) !==
      undefined,
    /**
     * The Splurge wishlist (CONTEXT.md → "The Rejected log is dual-purpose"): one row per
     * rejected *album* that carries a price, priciest-first — exactly the pricey reject a fat
     * war chest later clears. The stored quote is the affordability *hint*; the actual Splurge
     * re-prices live before buying. Albums with no recorded price (e.g. out-of-stock with no
     * quote) can't be sized against the chest, so they're excluded.
     */
    splurgeWishlist: (): SplurgeWishlistRow[] =>
      this.db
        .prepare(
          `SELECT album_key,
                  MIN(artist)                AS artist,
                  MIN(title)                 AS title,
                  MAX(lane)                  AS lane,
                  MAX(quoted_price_pence)    AS quoted_price_pence
             FROM rejected_log
            WHERE quoted_price_pence IS NOT NULL
            GROUP BY album_key
            ORDER BY quoted_price_pence DESC, album_key`,
        )
        .all() as SplurgeWishlistRow[],
    /** Clear every Rejected-log row for an album — e.g. when a Splurge finally lands it,
     *  so it stops being both "don't re-suggest" memory and a Splurge target. Returns the
     *  number of rows removed. */
    clearAlbum: (albumKey: string): number =>
      this.db.prepare("DELETE FROM rejected_log WHERE album_key = ?").run(albumKey).changes,
  };

  // ── orders (the lifecycle) ─────────────────────────────────────────────────
  readonly orders = {
    /** Park a quote as PROPOSED (ADR-0003): a quote, not a held cart. */
    propose: (input: OrderProposal): OrderRow => {
      const now = this.now();
      const info = this.db
        .prepare(
          `INSERT INTO orders
             (run_id, album_key, artist, title, lane, intent, why, source, listing_url,
              quoted_price_pence, discogs_release_id, status, created_at, updated_at)
           VALUES (@run_id, @album_key, @artist, @title, @lane, @intent, @why, @source,
                   @listing_url, @quoted_price_pence, @discogs_release_id, 'PROPOSED', @now, @now)`,
        )
        .run({
          run_id: input.run_id ?? null,
          album_key: input.album_key,
          artist: input.artist,
          title: input.title,
          lane: input.lane ?? null,
          intent: input.intent,
          why: input.why ?? null,
          source: input.source,
          listing_url: input.listing_url,
          quoted_price_pence: input.quoted_price_pence,
          discogs_release_id: input.discogs_release_id ?? null,
          now,
        });
      return this.orders.get(Number(info.lastInsertRowid))!;
    },
    get: (id: number): OrderRow | undefined =>
      this.db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as OrderRow | undefined,
    /** Orders newest-first, optionally bounded — used by the spend-ledger activity timeline. */
    all: (limit?: number): OrderRow[] =>
      limit === undefined
        ? (this.db.prepare("SELECT * FROM orders ORDER BY id DESC").all() as OrderRow[])
        : (this.db.prepare("SELECT * FROM orders ORDER BY id DESC LIMIT ?").all(limit) as OrderRow[]),
    listByStatus: (status: OrderStatus): OrderRow[] =>
      this.db
        .prepare("SELECT * FROM orders WHERE status = ? ORDER BY id DESC")
        .all(status) as OrderRow[],
    /** Transition status, optionally patching price/release fields and stamping a time. */
    setStatus: (id: number, status: OrderStatus, patch: OrderPatch = {}): OrderRow => {
      const now = this.now();
      const stampColumn: Partial<Record<OrderStatus, string>> = {
        APPROVED: "approved_at",
        ORDERED: "ordered_at",
        ARRIVED: "arrived_at",
      };
      const sets: string[] = ["status = @status", "updated_at = @now"];
      const params: Record<string, unknown> = { id, status, now };
      const stamp = stampColumn[status];
      if (stamp) sets.push(`${stamp} = @now`);
      if (patch.final_price_pence !== undefined) {
        sets.push("final_price_pence = @final_price_pence");
        params.final_price_pence = patch.final_price_pence;
      }
      if (patch.discogs_release_id !== undefined) {
        sets.push("discogs_release_id = @discogs_release_id");
        params.discogs_release_id = patch.discogs_release_id;
      }
      this.db.prepare(`UPDATE orders SET ${sets.join(", ")} WHERE id = @id`).run(params);
      return this.orders.get(id)!;
    },
    /**
     * Record the arrival Discogs write-back (issue #10): stamp the release that was logged
     * (patched here for an Amazon buy whose release id was unknown at order time) and the
     * instance id Discogs returned. `discogs_instance_id` becoming non-null is the idempotency
     * marker the Reveal reads to show "added to Discogs" and to refuse a second add.
     */
    recordDiscogsLog: (id: number, releaseId: number, instanceId: number): OrderRow => {
      const now = this.now();
      this.db
        .prepare(
          `UPDATE orders
              SET discogs_release_id = @releaseId,
                  discogs_instance_id = @instanceId,
                  discogs_logged_at = @now,
                  updated_at = @now
            WHERE id = @id`,
        )
        .run({ id, releaseId, instanceId, now });
      return this.orders.get(id)!;
    },
  };

  // ── ledger / balance ───────────────────────────────────────────────────────
  readonly ledger = {
    /**
     * Accrue the monthly cap into the war chest for a Run (issue #8): the balance is
     * `cap + carried-over unspent funds`, and "carried over" is automatic because the
     * running sum is never reset. Idempotent per Run — a second call for the same `runId`
     * is a no-op (returns null), so a re-entered or retried Run can't inflate the chest.
     */
    accrueCap: (runId: number, amountPence: number): LedgerRow | null => {
      const accrue = this.db.transaction((): LedgerRow | null => {
        const existing = this.db
          .prepare("SELECT 1 FROM ledger WHERE run_id = ? AND entry_type = 'cap_added' LIMIT 1")
          .get(runId);
        if (existing) return null;
        return this.ledger.append({
          run_id: runId,
          entry_type: "cap_added",
          amount_pence: amountPence,
          note: "Monthly cap",
        });
      });
      return accrue();
    },
    /** Append a signed entry; balance_after is computed from the running sum. */
    append: (entry: LedgerInput): LedgerRow => {
      const append = this.db.transaction((e: LedgerInput): LedgerRow => {
        const current = this.ledger.balance();
        const balanceAfter = current + e.amount_pence;
        const info = this.db
          .prepare(
            `INSERT INTO ledger
               (run_id, order_id, entry_type, amount_pence, balance_after_pence, note, created_at)
             VALUES (@run_id, @order_id, @entry_type, @amount_pence, @balance_after_pence, @note, @created_at)`,
          )
          .run({
            run_id: e.run_id ?? null,
            order_id: e.order_id ?? null,
            entry_type: e.entry_type,
            amount_pence: e.amount_pence,
            balance_after_pence: balanceAfter,
            note: e.note ?? null,
            created_at: this.now(),
          });
        return this.db
          .prepare("SELECT * FROM ledger WHERE id = ?")
          .get(Number(info.lastInsertRowid)) as LedgerRow;
      });
      return append(entry);
    },
    /** Current war-chest balance in pence (the running sum is the source of truth). */
    balance: (): number => {
      const row = this.db
        .prepare("SELECT COALESCE(SUM(amount_pence), 0) AS total FROM ledger")
        .get() as { total: number };
      return row.total;
    },
    list: (limit = 100): LedgerRow[] =>
      this.db.prepare("SELECT * FROM ledger ORDER BY id DESC LIMIT ?").all(limit) as LedgerRow[],
    /**
     * The spend-ledger transparency surface (issue #8): every money movement (cap accrued,
     * order placed — carrying the running balance) merged with the order lifecycle (a quote
     * parked, an approval, an arrival), newest-first. The *spend* of an order is the
     * `order_placed` money row (it carries the balance); the order's own `ordered_at` stamp is
     * deliberately not re-emitted so the spend isn't double-listed. Title-hiding by design.
     */
    activity: (limit = 100): LedgerActivityEvent[] => {
      // Bound both sources to `limit` before the in-memory merge: the newest `limit` merged
      // events can only come from the newest `limit` rows of each source, so the full history
      // never needs loading (an order yields ≤3 events, a ledger row exactly 1).
      const events: LedgerActivityEvent[] = [];
      for (const row of this.ledger.list(limit)) {
        events.push({
          kind: row.entry_type,
          at: row.created_at,
          amountPence: row.amount_pence,
          balanceAfterPence: row.balance_after_pence,
          source: undefined,
          orderId: row.order_id ?? undefined,
          note: row.note ?? undefined,
        });
      }
      for (const order of this.orders.all(limit)) {
        events.push({ kind: "quote", at: order.created_at, source: order.source, orderId: order.id });
        if (order.approved_at) {
          events.push({ kind: "approved", at: order.approved_at, source: order.source, orderId: order.id });
        }
        if (order.arrived_at) {
          events.push({ kind: "arrived", at: order.arrived_at, source: order.source, orderId: order.id });
        }
      }
      // Newest-first; id is the deterministic tiebreak when timestamps collide (same-clock tests).
      events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : (b.orderId ?? 0) - (a.orderId ?? 0)));
      return events.slice(0, limit);
    },
  };

  // ── config (typed key/value) ────────────────────────────────────────────────
  readonly config = {
    get: (): Config => {
      const rows = this.db.prepare("SELECT key, value FROM config").all() as {
        key: string;
        value: string;
      }[];
      const stored: Record<string, unknown> = {};
      for (const r of rows) stored[r.key] = JSON.parse(r.value);
      return { ...DEFAULT_CONFIG, ...stored } as Config;
    },
    set: (patch: Partial<Config>): Config => {
      const now = this.now();
      const stmt = this.db.prepare(
        `INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      );
      const write = this.db.transaction((p: Partial<Config>) => {
        for (const [key, value] of Object.entries(p)) {
          stmt.run(key, JSON.stringify(value), now);
        }
      });
      write(patch);
      return this.config.get();
    },
    isPaused: (): boolean => this.config.get().paused,
  };
}

/** Convenience factory mirroring `new Store(db, opts)`. */
export function createStore(db: DB, opts?: StoreOptions): Store {
  return new Store(db, opts);
}

// ── input shapes (looser than rows: ids/timestamps are assigned by the store) ──

export interface CollectionInput {
  album_key: string;
  artist: string;
  title: string;
  year?: number | null;
  discogs_release_id?: number | null;
  discogs_instance_id?: number | null;
  genres?: string[];
  styles?: string[];
  date_added?: string | null;
  synced_at?: string;
}

/** One Splurge target derived from the Rejected log: an album + its highest recorded quote. */
export interface SplurgeWishlistRow {
  album_key: string;
  artist: string;
  title: string;
  /** The Lane the record was originally rejected from, if recorded — carried to the Reveal. */
  lane: Lane | null;
  quoted_price_pence: number;
}

export interface RejectedInput {
  album_key: string;
  artist: string;
  title: string;
  lane?: Lane | null;
  reason: RejectReason;
  source?: Source | null;
  listing_url?: string | null;
  quoted_price_pence?: number | null;
  run_id?: number | null;
}

export interface OrderProposal {
  run_id?: number | null;
  album_key: string;
  artist: string;
  title: string;
  lane?: Lane | null;
  intent: BuyIntent;
  why?: string | null;
  source: Source;
  listing_url: string;
  quoted_price_pence: number;
  discogs_release_id?: number | null;
}

export interface OrderPatch {
  final_price_pence?: number;
  discogs_release_id?: number;
}

export interface LedgerInput {
  run_id?: number | null;
  order_id?: number | null;
  entry_type: LedgerEntryType;
  amount_pence: number;
  note?: string | null;
}
