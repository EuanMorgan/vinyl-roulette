import type { DB } from "./db";
import { migrations } from "./migrations";

/**
 * Apply any not-yet-applied migrations, idempotently. Tracks applied versions in
 * `schema_migrations`, so running this on every open is safe and a no-op once current.
 * Each migration runs in its own transaction.
 */
export function runMigrations(db: DB): { applied: string[] } {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const isApplied = db.prepare<[string], { version: string }>(
    "SELECT version FROM schema_migrations WHERE version = ?",
  );
  const record = db.prepare<[string, string]>(
    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
  );

  const applied: string[] = [];
  for (const migration of migrations) {
    if (isApplied.get(migration.version)) continue;
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.version, new Date().toISOString());
    });
    apply();
    applied.push(migration.version);
  }
  return { applied };
}
