/**
 * Discogs → collection-cache read-sync (issue #3).
 *
 * `syncCollection` is the pure spine: hand it any `DiscogsAdapter` (real or fake) and a
 * `Store`, and it pulls the library, normalizes each owned instance to an album-level
 * `album_key`, and idempotently upserts the collection cache. It performs no I/O of its
 * own beyond the injected adapter + store, so tests fake the adapter at its boundary
 * (no live Discogs call — ADR #2 testing convention).
 *
 * Album identity is `album_key` (artist|title), NOT pressing: owning any pressing of an
 * album means the app never buys that album again (CONTEXT.md → Collection / Owned set).
 * The owned set the picker later excludes is this cache ∪ the purchase ledger; see
 * `store.owned`.
 */
import { pathToFileURL } from "node:url";
import type { DiscogsAdapter } from "@/adapters/types";
import { discogsAdapterFromEnv } from "@/adapters/discogs";
import { openDb, resolveDbPath } from "@/store/db";
import { Store, type CollectionInput } from "@/store/store";
import { albumKey } from "@/store/types";

export interface SyncSummary {
  /** Owned instances pulled from Discogs (one per physical copy). */
  fetched: number;
  /** Distinct albums after collapsing pressings to album_key. */
  distinctAlbums: number;
}

export async function syncCollection(
  adapter: DiscogsAdapter,
  store: Store,
): Promise<SyncSummary> {
  const items = await adapter.fetchCollection();

  const rows: CollectionInput[] = items.map((item) => ({
    album_key: albumKey(item.artist, item.title),
    artist: item.artist,
    title: item.title,
    year: item.year ?? null,
    discogs_release_id: item.discogsReleaseId ?? null,
    discogs_instance_id: item.discogsInstanceId ?? null,
    genres: item.genres,
    styles: item.styles,
    date_added: item.dateAdded ?? null,
  }));

  store.collection.upsert(rows);

  return {
    fetched: rows.length,
    distinctAlbums: new Set(rows.map((r) => r.album_key)).size,
  };
}

async function main(): Promise<void> {
  const adapter = discogsAdapterFromEnv();
  if (!adapter) {
    console.error(
      "Discogs not configured. Set DISCOGS_USERNAME and DISCOGS_TOKEN " +
        "(personal access token from https://www.discogs.com/settings/developers) to sync.",
    );
    process.exitCode = 1;
    return;
  }
  const path = resolveDbPath();
  const db = openDb(path);
  try {
    const store = new Store(db);
    const summary = await syncCollection(adapter, store);
    console.log(
      `Synced ${summary.fetched} owned copies (${summary.distinctAlbums} distinct albums) into ${path}`,
    );
  } finally {
    db.close();
  }
}

// Only run when invoked as a script, not when imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
