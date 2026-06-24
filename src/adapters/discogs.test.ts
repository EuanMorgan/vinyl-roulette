import { describe, it, expect } from "vitest";
import { DiscogsApiError, HttpDiscogsAdapter } from "./discogs";

/**
 * These exercise the real adapter's pagination + rate-limit handling with an injected
 * `fetch` and `sleep` — no live Discogs call, no real waiting. The `DiscogsAdapter`
 * *interface* is faked elsewhere (fakes.ts); this verifies the concrete HTTP plumbing.
 */

type FakeResponse = {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
};

/** A fetch stand-in that returns queued responses in order and records the URLs hit. */
function fakeFetch(responses: FakeResponse[]) {
  const calls: string[] = [];
  let i = 0;
  const fn = (async (url: string) => {
    calls.push(url);
    const r = responses[Math.min(i, responses.length - 1)] ?? {};
    i++;
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => r.headers?.[k] ?? null },
      json: async () => r.body,
    };
  }) as unknown as typeof fetch;
  return { fn, calls, slept: [] as number[] };
}

function page(pageNum: number, pages: number, releases: unknown[]) {
  return { body: { pagination: { page: pageNum, pages }, releases } };
}

describe("HttpDiscogsAdapter", () => {
  it("walks every page and maps releases to collection items", async () => {
    const f = fakeFetch([
      page(1, 2, [
        {
          id: 100,
          instance_id: 11,
          date_added: "2024-01-01T00:00:00-08:00",
          basic_information: {
            title: "Abbey Road",
            year: 1969,
            artists: [{ name: "The Beatles" }],
            genres: ["Rock"],
            styles: ["Pop Rock"],
          },
        },
      ]),
      page(2, 2, [
        {
          id: 200,
          instance_id: 22,
          basic_information: {
            title: "Kind of Blue",
            year: 1959,
            artists: [{ name: "Miles Davis" }],
            genres: ["Jazz"],
          },
        },
      ]),
    ]);

    const adapter = new HttpDiscogsAdapter(
      { username: "euan", token: "t" },
      { fetch: f.fn, sleep: async (ms) => void f.slept.push(ms) },
    );
    const items = await adapter.fetchCollection();

    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]).toContain("/users/euan/collection/folders/0/releases?page=1");
    expect(f.calls[1]).toContain("page=2");
    expect(items.map((i) => i.title)).toEqual(["Abbey Road", "Kind of Blue"]);
    expect(items[0]).toMatchObject({
      artist: "The Beatles",
      discogsReleaseId: 100,
      discogsInstanceId: 11,
      genres: ["Rock"],
      styles: ["Pop Rock"],
    });
    // date_added is normalized from Discogs' offset form to UTC (migrations.ts convention).
    expect(items[0]?.dateAdded).toBe("2024-01-01T08:00:00.000Z");
  });

  it("joins multiple artists and strips the (n) disambiguation suffix", async () => {
    const f = fakeFetch([
      page(1, 1, [
        {
          id: 1,
          instance_id: 1,
          basic_information: {
            title: "Watch the Throne",
            artists: [
              { name: "Jay-Z (2)", join: "&" },
              { name: "Kanye West" },
            ],
          },
        },
      ]),
    ]);
    const adapter = new HttpDiscogsAdapter(
      { username: "euan", token: "t" },
      { fetch: f.fn, sleep: async () => {} },
    );
    const items = await adapter.fetchCollection();
    expect(items[0]?.artist).toBe("Jay-Z & Kanye West");
  });

  it("backs off and retries on HTTP 429, then succeeds", async () => {
    const slept: number[] = [];
    const f = fakeFetch([{ status: 429 }, page(1, 1, [])]);
    const adapter = new HttpDiscogsAdapter(
      { username: "euan", token: "t" },
      { fetch: f.fn, sleep: async (ms) => void slept.push(ms) },
    );
    const items = await adapter.fetchCollection();
    expect(items).toEqual([]);
    expect(slept).toHaveLength(1); // one backoff before the retry
    expect(f.calls).toHaveLength(2);
  });

  it("honours a Retry-After header on 429", async () => {
    const slept: number[] = [];
    const f = fakeFetch([{ status: 429, headers: { "Retry-After": "2" } }, page(1, 1, [])]);
    const adapter = new HttpDiscogsAdapter(
      { username: "euan", token: "t" },
      { fetch: f.fn, sleep: async (ms) => void slept.push(ms) },
    );
    await adapter.fetchCollection();
    expect(slept).toEqual([2000]); // 2s from the header, not the 60s default
  });

  it("gives up after maxRetries of 429", async () => {
    const f = fakeFetch([{ status: 429 }]);
    const adapter = new HttpDiscogsAdapter(
      { username: "euan", token: "t", maxRetries: 2 },
      { fetch: f.fn, sleep: async () => {} },
    );
    await expect(adapter.fetchCollection()).rejects.toBeInstanceOf(DiscogsApiError);
  });

  it("pauses when the rate-limit budget runs low", async () => {
    const slept: number[] = [];
    const f = fakeFetch([
      { ...page(1, 1, []), headers: { "X-Discogs-Ratelimit-Remaining": "2" } },
    ]);
    const adapter = new HttpDiscogsAdapter(
      { username: "euan", token: "t" },
      { fetch: f.fn, sleep: async (ms) => void slept.push(ms) },
    );
    await adapter.fetchCollection();
    expect(slept).toHaveLength(1); // breathed before it would hit the wall
  });

  it("requires username and token", () => {
    expect(() => new HttpDiscogsAdapter({ username: "", token: "t" })).toThrow();
    expect(() => new HttpDiscogsAdapter({ username: "euan", token: "" })).toThrow();
  });
});
