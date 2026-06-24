import "server-only";

import { openDb } from "@/store/db";
import { Store } from "@/store/store";

/**
 * The UI's handle on the spine. `server-only` makes importing this from a client
 * component a build error — the SQLite file is opened server-side exclusively (ADR-0002).
 *
 * A module-level singleton keeps one connection per server process across requests.
 */
let singleton: Store | undefined;

export function getStore(): Store {
  if (!singleton) {
    singleton = new Store(openDb());
  }
  return singleton;
}
