import type { DB } from "./db";
import { runMigrations } from "./migrate";
import {
  DEFAULT_CONFIG,
  type Config,
  type CollectionRow,
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
    /** Album-level ownership check (CONTEXT.md → Collection). */
    ownsAlbum: (albumKey: string): boolean =>
      this.db.prepare("SELECT 1 FROM collection WHERE album_key = ? LIMIT 1").get(albumKey) !==
      undefined,
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
  };

  // ── ledger / balance ───────────────────────────────────────────────────────
  readonly ledger = {
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
