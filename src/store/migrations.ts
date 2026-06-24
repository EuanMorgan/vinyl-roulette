/**
 * The schema IS the contract (ADR-0002): the agent and the UI are two independent
 * clients that meet only at this SQLite file, with no API between them. Both apply
 * these migrations on open, so the table shapes here are the project-wide agreement.
 *
 * Conventions:
 * - Money is stored as INTEGER **pence** everywhere (never floats). See `money.ts`.
 * - Timestamps are ISO-8601 UTC strings (TEXT), written by the app, not SQLite.
 * - Album identity for dupe-avoidance is the normalized `album_key` (artist|title),
 *   because matching is at album level, not pressing level (CONTEXT.md → Collection).
 */
export type Migration = { version: string; sql: string };

export const migrations: Migration[] = [
  {
    version: "001_initial",
    sql: /* sql */ `
      -- Each scheduled (or manual) invocation of the agent. Gives every later row a
      -- run it belongs to, and is the simplest thing the walking-skeleton E2E writes.
      CREATE TABLE runs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        trigger       TEXT NOT NULL CHECK (trigger IN ('scheduled', 'manual')),
        status        TEXT NOT NULL DEFAULT 'started'
                        CHECK (status IN ('started', 'finished', 'failed')),
        summary       TEXT,
        started_at    TEXT NOT NULL,
        finished_at   TEXT
      );

      -- Collection cache: Euan's Discogs library, read-synced. Album-level identity
      -- (album_key) is what dupe-avoidance matches on; discogs_instance_id keeps the
      -- specific owned pressing for logging/round-trips without being the match key.
      CREATE TABLE collection (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        album_key           TEXT NOT NULL,
        artist              TEXT NOT NULL,
        title               TEXT NOT NULL,
        year                INTEGER,
        discogs_release_id  INTEGER,
        discogs_instance_id INTEGER UNIQUE,
        genres              TEXT,            -- JSON array of strings
        styles              TEXT,            -- JSON array of strings
        date_added          TEXT,            -- when Euan added it on Discogs
        synced_at           TEXT NOT NULL
      );
      CREATE INDEX idx_collection_album_key ON collection (album_key);

      -- Ratings apply to the WHOLE collection, not just purchased records, and are
      -- keyed by album identity so they survive re-syncs and attach to bought albums
      -- too. "Ownership is not endorsement": a row here is the only positive signal.
      CREATE TABLE ratings (
        album_key   TEXT PRIMARY KEY,
        artist      TEXT NOT NULL,
        title       TEXT NOT NULL,
        rating      INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      -- Free-text notes are append-only (Euan may add several over time), so they are
      -- a separate table from the single-value rating.
      CREATE TABLE notes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        album_key   TEXT NOT NULL,
        artist      TEXT NOT NULL,
        title       TEXT NOT NULL,
        body        TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX idx_notes_album_key ON notes (album_key);

      -- Records the Brain wanted but couldn't buy (over budget / out of stock /
      -- declined). Dual-purpose: "don't re-suggest" memory AND the Splurge wishlist.
      CREATE TABLE rejected_log (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        album_key       TEXT NOT NULL,
        artist          TEXT NOT NULL,
        title           TEXT NOT NULL,
        lane            TEXT CHECK (lane IN ('complete', 'adjacent', 'stretch')),
        reason          TEXT NOT NULL
                          CHECK (reason IN ('over_budget', 'out_of_stock', 'declined', 'stale')),
        source          TEXT CHECK (source IN ('discogs', 'amazon')),
        listing_url     TEXT,
        quoted_price_pence INTEGER,
        run_id          INTEGER REFERENCES runs (id),
        created_at      TEXT NOT NULL
      );
      CREATE INDEX idx_rejected_album_key ON rejected_log (album_key);

      -- The order lifecycle (ADR-0003 / CONTEXT "Order lifecycle"):
      --   PROPOSED -> APPROVED -> ORDERED -> ARRIVED
      -- with STALE / FAILED / DECLINED as exits. A PROPOSED row stores a *quote*
      -- (record + source + listing URL + landed price), NOT a held cart.
      CREATE TABLE orders (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id              INTEGER REFERENCES runs (id),
        album_key           TEXT NOT NULL,
        artist              TEXT NOT NULL,
        title               TEXT NOT NULL,
        lane                TEXT CHECK (lane IN ('complete', 'adjacent', 'stretch')),
        intent              TEXT NOT NULL CHECK (intent IN ('gap_fill', 'splurge')),
        why                 TEXT,            -- the explanation surfaced at Reveal
        source              TEXT NOT NULL CHECK (source IN ('discogs', 'amazon')),
        listing_url         TEXT NOT NULL,
        quoted_price_pence  INTEGER NOT NULL,    -- landed cost at prep time
        final_price_pence   INTEGER,             -- what was actually paid at ORDERED
        discogs_release_id  INTEGER,             -- for one-tap Discogs logging on arrival
        status              TEXT NOT NULL DEFAULT 'PROPOSED'
                              CHECK (status IN ('PROPOSED','APPROVED','ORDERED','ARRIVED','STALE','FAILED','DECLINED')),
        created_at          TEXT NOT NULL,
        approved_at         TEXT,
        ordered_at          TEXT,
        arrived_at          TEXT,
        updated_at          TEXT NOT NULL
      );
      CREATE INDEX idx_orders_status ON orders (status);

      -- Spend ledger: the always-on transparency backstop. Append-only. Every funds
      -- movement is a signed row in pence; the war-chest balance is the running sum.
      -- balance_after_pence is denormalized for display but the SUM is the truth.
      CREATE TABLE ledger (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id              INTEGER REFERENCES runs (id),
        order_id            INTEGER REFERENCES orders (id),
        entry_type          TEXT NOT NULL
                              CHECK (entry_type IN ('cap_added','order_placed','refund','adjustment')),
        amount_pence        INTEGER NOT NULL,    -- signed: + adds funds, - spends
        balance_after_pence INTEGER NOT NULL,
        note                TEXT,
        created_at          TEXT NOT NULL
      );

      -- Config as typed key/value: monthly cap, per-purchase ceiling, chaos dial,
      -- price-drift tolerance, global pause flag. Read through typed accessors.
      CREATE TABLE config (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL,           -- JSON-encoded
        updated_at  TEXT NOT NULL
      );
    `,
  },
];
