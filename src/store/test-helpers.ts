import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "./db";
import { Store, type Clock } from "./store";

/**
 * Open a Store backed by a real temp DB file (per issue #2: store tests run against a
 * temp file, no network/browser). Returns the store plus a cleanup that closes and
 * deletes the file. A fixed clock keeps timestamps deterministic.
 */
export function makeTempStore(clock?: Clock): { store: Store; db: DB; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "vinyl-test-"));
  const path = join(dir, "test.db");
  const db = openDb(path);
  const store = new Store(db, { clock: clock ?? (() => "2026-06-24T12:00:00.000Z") });
  return {
    store,
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
