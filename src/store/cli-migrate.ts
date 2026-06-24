/** Apply migrations to the configured DB file. Usage: `npm run db:migrate`. */
import { openDb, resolveDbPath } from "./db";
import { runMigrations } from "./migrate";

const path = resolveDbPath();
const db = openDb(path);
const { applied } = runMigrations(db);
db.close();

if (applied.length === 0) {
  console.log(`Schema up to date at ${path}`);
} else {
  console.log(`Applied ${applied.length} migration(s) to ${path}: ${applied.join(", ")}`);
}
