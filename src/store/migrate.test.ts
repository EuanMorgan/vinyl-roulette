import { describe, it, expect, afterEach } from "vitest";
import { runMigrations } from "./migrate";
import { migrations } from "./migrations";
import { makeTempStore } from "./test-helpers";

describe("migration runner", () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  it("applies every migration on a fresh DB", () => {
    const t = makeTempStore();
    cleanup = t.cleanup;
    // Store constructor already migrated; assert the bookkeeping recorded all versions.
    const rows = t.db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as { version: string }[];
    expect(rows.map((r) => r.version)).toEqual(migrations.map((m) => m.version));
  });

  it("is idempotent — re-running applies nothing new", () => {
    const t = makeTempStore();
    cleanup = t.cleanup;
    const second = runMigrations(t.db);
    expect(second.applied).toEqual([]);
  });

  it("creates the contract tables", () => {
    const t = makeTempStore();
    cleanup = t.cleanup;
    const names = (
      t.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    for (const table of [
      "runs",
      "collection",
      "ratings",
      "notes",
      "rejected_log",
      "orders",
      "ledger",
      "config",
    ]) {
      expect(names).toContain(table);
    }
  });
});
