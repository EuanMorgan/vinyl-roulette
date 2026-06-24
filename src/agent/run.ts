/**
 * The agent entrypoint (ADR-0001). In production this is what the scheduled `claude -p`
 * invocation drives each month; the "Run now" UI button shells out to the same script.
 *
 * For the walking skeleton (issue #2) it does the minimal real thing: open the single
 * SQLite spine directly (no API — ADR-0002), record a Run, and finish it. The UI then
 * reads that row back. Later slices grow the body into decide → price → drive-to-payment.
 *
 * Usage: `npm run agent:run [-- --trigger scheduled]`
 */
import { pathToFileURL } from "node:url";
import { openDb, resolveDbPath } from "@/store/db";
import { Store } from "@/store/store";
import type { RunTrigger } from "@/store/types";

function parseTrigger(argv: string[]): RunTrigger {
  const i = argv.indexOf("--trigger");
  const value = i >= 0 ? argv[i + 1] : undefined;
  return value === "scheduled" ? "scheduled" : "manual";
}

export function runAgent(store: Store, trigger: RunTrigger): number {
  if (store.config.isPaused()) {
    console.log("Paused — skipping Run (no future buying while paused).");
    return -1;
  }
  const run = store.runs.create(trigger);
  // Skeleton body: nothing to decide yet. Record that the Run executed.
  store.runs.finish(run.id, "finished", "walking-skeleton run: spine opened, row written");
  return run.id;
}

function main(): void {
  const trigger = parseTrigger(process.argv.slice(2));
  const path = resolveDbPath();
  const db = openDb(path);
  try {
    const store = new Store(db);
    const id = runAgent(store, trigger);
    if (id >= 0) console.log(`Run #${id} (${trigger}) recorded in ${path}`);
  } finally {
    db.close();
  }
}

// Only run when invoked as a script, not when imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
