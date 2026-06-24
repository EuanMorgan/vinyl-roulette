import { describe, it, expect, afterEach } from "vitest";
import { FakeDiscogsAdapter } from "@/adapters/fakes";
import { makeTempStore } from "@/store/test-helpers";
import { albumKey } from "@/store/types";
import { syncCollection } from "./sync-collection";

describe("syncCollection (Discogs → collection cache)", () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  it("pulls the library, with genres/styles, through the faked adapter boundary", async () => {
    const t = makeTempStore();
    cleanup = t.cleanup;
    const discogs = new FakeDiscogsAdapter([
      {
        artist: "The Beatles",
        title: "Abbey Road",
        year: 1969,
        discogsReleaseId: 100,
        discogsInstanceId: 11,
        genres: ["Rock"],
        styles: ["Pop Rock"],
        dateAdded: "2024-01-01T00:00:00Z",
      },
    ]);

    const summary = await syncCollection(discogs, t.store);

    expect(summary).toEqual({ fetched: 1, distinctAlbums: 1 });
    const rows = t.store.collection.all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      album_key: albumKey("The Beatles", "Abbey Road"),
      artist: "The Beatles",
      title: "Abbey Road",
      year: 1969,
      discogs_release_id: 100,
      discogs_instance_id: 11,
    });
    expect(JSON.parse(rows[0]!.genres!)).toEqual(["Rock"]);
    expect(JSON.parse(rows[0]!.styles!)).toEqual(["Pop Rock"]);
  });

  it("collapses two pressings of one album to a single owned album_key", async () => {
    const t = makeTempStore();
    cleanup = t.cleanup;
    const discogs = new FakeDiscogsAdapter([
      { artist: "Pink Floyd", title: "The Wall", discogsInstanceId: 1, discogsReleaseId: 10 },
      // Different pressing (instance + release) of the SAME album.
      { artist: "Pink Floyd", title: "The Wall", discogsInstanceId: 2, discogsReleaseId: 99 },
    ]);

    const summary = await syncCollection(discogs, t.store);

    // Two physical copies fetched, but one album for dupe-avoidance.
    expect(summary).toEqual({ fetched: 2, distinctAlbums: 1 });
    expect(t.store.collection.all()).toHaveLength(2); // both pressings cached
    expect(t.store.owned.has(albumKey("Pink Floyd", "The Wall"))).toBe(true);
    expect(t.store.owned.keys()).toEqual([albumKey("Pink Floyd", "The Wall")]);
  });

  it("is idempotent: re-syncing the same library does not duplicate rows", async () => {
    const t = makeTempStore();
    cleanup = t.cleanup;
    const discogs = new FakeDiscogsAdapter([
      { artist: "Portishead", title: "Dummy", discogsInstanceId: 7, discogsReleaseId: 70 },
    ]);

    await syncCollection(discogs, t.store);
    await syncCollection(discogs, t.store); // run it again

    expect(t.store.collection.all()).toHaveLength(1);
  });
});
