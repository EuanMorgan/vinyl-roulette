import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = Database.Database;

/** Default location of the single local SQLite spine (ADR-0002). */
export const DEFAULT_DB_PATH = "./data/vinyl.db";

/** Resolve the DB path: explicit arg > VINYL_DB_PATH env > default. */
export function resolveDbPath(explicit?: string): string {
  return explicit ?? process.env.VINYL_DB_PATH ?? DEFAULT_DB_PATH;
}

/**
 * Open (creating if needed) the SQLite file. Pass ":memory:" or a temp path in tests.
 * Enables WAL + foreign keys; both clients open the file the same way.
 */
export function openDb(path?: string): DB {
  const resolved = resolveDbPath(path);
  if (resolved !== ":memory:") {
    mkdirSync(dirname(resolved), { recursive: true });
  }
  const db = new Database(resolved);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}
