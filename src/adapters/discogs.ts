/**
 * Real Discogs collection sync (issue #3) behind the `DiscogsAdapter` seam from #2.
 *
 * Production code still depends only on the `DiscogsAdapter` interface; this is the one
 * concrete implementation. Tests fake the *interface* (see `fakes.ts`), so this file's own
 * pagination/rate-limit logic is exercised separately with an injected `fetch` (no live
 * Discogs call — see `discogs.test.ts`).
 *
 * ## Auth (OAuth scope)
 * This is a single-user local app (ADR-0001), so it authenticates with a Discogs
 * **personal access token** rather than the 3-legged OAuth dance. A personal token is
 * scoped to the token-owner's own account, which is exactly what both halves of this
 * adapter need: read *your* collection (the monthly sync), and — for the arrival Reveal
 * (issue #10) — search releases and add one back to *your* collection. A personal token
 * carries that write scope. Sent as `Authorization: Discogs token=<token>`.
 *
 * ## Rate limits
 * Discogs allows ~60 authenticated requests/minute and reports budget on every response:
 *   X-Discogs-Ratelimit            — window size
 *   X-Discogs-Ratelimit-Used       — used this window
 *   X-Discogs-Ratelimit-Remaining  — left this window
 * A full collection is a handful of 100-item pages, well under the cap, but to stay a good
 * citizen we (a) pause briefly before the next page when `Remaining` is low, and (b) honour
 * HTTP 429 by backing off and retrying. The window is a rolling minute with no documented
 * reset header, so backoff is a fixed cooldown.
 */
import type { DiscogsAdapter, DiscogsCollectionItem, DiscogsReleaseMatch } from "./types";

const DISCOGS_API = "https://api.discogs.com";
/**
 * Folder to add an arrival to. Folder 0 is the read-only "All" pseudo-folder (you can't POST
 * into it); folder 1 is the built-in "Uncategorized" folder every Discogs account has, which
 * is where a one-tap add belongs — Euan can re-file it later if he wants.
 */
const UNCATEGORIZED_FOLDER = 1;
/** Default page size for the best-guess release search — a short shortlist for the confirm UI. */
const DEFAULT_SEARCH_LIMIT = 10;
/** Discogs *requires* a descriptive User-Agent or it returns 403. */
const DEFAULT_USER_AGENT = "VinylRoulette/0.1 (+https://github.com/EuanMorgan/vinyl-autobuy)";
const DEFAULT_PER_PAGE = 100; // Discogs max; fewest requests for a full sync
/** Pause before the next page once the window budget drops to this many requests. */
const RATELIMIT_LOW_WATERMARK = 5;
const RATELIMIT_COOLDOWN_MS = 60_000; // rolling 1-minute window
const DEFAULT_MAX_RETRIES = 3;

export interface DiscogsAdapterConfig {
  username: string;
  token: string;
  userAgent?: string;
  baseUrl?: string;
  perPage?: number;
  maxRetries?: number;
}

/** Injectable side-effects so the adapter is testable without a network or real waiting. */
export interface DiscogsAdapterDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

// ── Discogs response shapes (only the fields we read) ──────────────────────────
interface DiscogsArtist {
  name: string;
  /** Disambiguation-suffixed display name, e.g. "Nirvana (2)". */
  anv?: string;
  /** Joiner between this artist and the next (", ", "&", "Feat."). */
  join?: string;
}
interface DiscogsBasicInformation {
  title: string;
  year?: number;
  artists?: DiscogsArtist[];
  genres?: string[];
  styles?: string[];
}
interface DiscogsReleaseInstance {
  id: number; // release id
  instance_id: number; // this owned copy
  date_added?: string;
  basic_information?: DiscogsBasicInformation;
}
interface DiscogsCollectionPage {
  pagination: { page: number; pages: number };
  releases: DiscogsReleaseInstance[];
}
/** One hit from GET /database/search (only the fields the Reveal confirm UI shows). */
interface DiscogsSearchResult {
  id: number;
  /** Discogs renders this as "Artist - Title". */
  title?: string;
  year?: string | number;
  format?: string[];
  label?: string[];
  country?: string;
  thumb?: string;
}
interface DiscogsSearchResponse {
  results?: DiscogsSearchResult[];
}
/** POST .../collection/folders/{id}/releases/{release} returns the new owned copy. */
interface DiscogsAddInstanceResponse {
  instance_id: number;
}

/**
 * Normalize a timestamp to ISO-8601 **UTC** (the project's storage convention —
 * migrations.ts header). Discogs emits offset form, e.g. "2024-01-01T00:00:00-08:00".
 * Returns undefined for missing/unparseable input rather than storing garbage.
 */
function toUtcIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** Strip Discogs' "(2)" disambiguation suffix from an artist name. */
function cleanArtistName(name: string): string {
  return name.replace(/\s*\(\d+\)\s*$/, "").trim();
}

/** Join a release's artists honouring Discogs' per-artist `join` tokens. */
function artistDisplay(artists: DiscogsArtist[] | undefined): string {
  if (!artists || artists.length === 0) return "";
  let out = "";
  artists.forEach((a, i) => {
    out += cleanArtistName(a.name);
    if (i < artists.length - 1) {
      const join = a.join?.trim();
      out += join && join !== "," ? ` ${join} ` : ", ";
    }
  });
  return out.trim();
}

function toItem(r: DiscogsReleaseInstance): DiscogsCollectionItem {
  const bi = r.basic_information;
  return {
    artist: artistDisplay(bi?.artists),
    title: bi?.title ?? "",
    year: bi?.year && bi.year > 0 ? bi.year : undefined,
    discogsReleaseId: r.id,
    discogsInstanceId: r.instance_id,
    genres: bi?.genres,
    styles: bi?.styles,
    dateAdded: toUtcIso(r.date_added),
  };
}

/**
 * Map a search hit to a `DiscogsReleaseMatch` for the Reveal confirm UI. Discogs renders the
 * result `title` as "Artist - Album"; we split on the first " - " so the artist and album show
 * separately, falling back to the whole string as the title when there's no separator.
 */
function toMatch(r: DiscogsSearchResult): DiscogsReleaseMatch {
  const full = (r.title ?? "").trim();
  const sep = full.indexOf(" - ");
  const artist = sep >= 0 ? full.slice(0, sep).trim() : "";
  const title = sep >= 0 ? full.slice(sep + 3).trim() : full;
  const year = r.year !== undefined && Number(r.year) > 0 ? Number(r.year) : undefined;
  const detailBits = [...(r.format ?? []), r.country].filter((s): s is string => !!s);
  return {
    releaseId: r.id,
    artist,
    title,
    year,
    detail: detailBits.length > 0 ? detailBits.join(" · ") : undefined,
    thumbUrl: r.thumb || undefined,
  };
}

export class DiscogsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DiscogsApiError";
  }
}

/**
 * The real Discogs read-sync. `fetchCollection` walks the "All" folder (id 0) page by
 * page and maps each owned instance to a `DiscogsCollectionItem`.
 */
export class HttpDiscogsAdapter implements DiscogsAdapter {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly userAgent: string;
  private readonly baseUrl: string;
  private readonly perPage: number;
  private readonly maxRetries: number;

  constructor(
    private readonly config: DiscogsAdapterConfig,
    deps: DiscogsAdapterDeps = {},
  ) {
    if (!config.username) throw new Error("HttpDiscogsAdapter: username is required");
    if (!config.token) throw new Error("HttpDiscogsAdapter: token is required");
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.userAgent = config.userAgent ?? DEFAULT_USER_AGENT;
    this.baseUrl = config.baseUrl ?? DISCOGS_API;
    this.perPage = config.perPage ?? DEFAULT_PER_PAGE;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  async fetchCollection(): Promise<DiscogsCollectionItem[]> {
    const items: DiscogsCollectionItem[] = [];
    let page = 1;
    let pages = 1;
    do {
      const url =
        `${this.baseUrl}/users/${encodeURIComponent(this.config.username)}` +
        `/collection/folders/0/releases?page=${page}&per_page=${this.perPage}`;
      const body = await this.request<DiscogsCollectionPage>(url);
      for (const release of body.releases) items.push(toItem(release));
      pages = body.pagination.pages;
      page += 1;
    } while (page <= pages);
    return items;
  }

  /** Best-guess release search for an Amazon-sourced arrival whose release id is unknown. */
  async searchReleases(query: { artist: string; title: string }): Promise<DiscogsReleaseMatch[]> {
    const params = new URLSearchParams({
      type: "release",
      artist: query.artist,
      release_title: query.title,
      per_page: String(DEFAULT_SEARCH_LIMIT),
    });
    const body = await this.request<DiscogsSearchResponse>(
      `${this.baseUrl}/database/search?${params.toString()}`,
    );
    return (body.results ?? []).map(toMatch);
  }

  /** Add a release to the token-owner's collection (the arrival write-back); returns its instance. */
  async addToCollection(releaseId: number): Promise<{ instanceId: number }> {
    const url =
      `${this.baseUrl}/users/${encodeURIComponent(this.config.username)}` +
      `/collection/folders/${UNCATEGORIZED_FOLDER}/releases/${releaseId}`;
    const body = await this.request<DiscogsAddInstanceResponse>(url, { method: "POST" });
    return { instanceId: body.instance_id };
  }

  /**
   * One authenticated request, retrying on HTTP 429 (honouring Retry-After) and pausing when
   * the rate-limit budget runs low — the good-citizen behaviour every Discogs call shares.
   */
  private async request<T>(url: string, init: { method?: string } = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(url, {
        method: init.method,
        headers: {
          Authorization: `Discogs token=${this.config.token}`,
          "User-Agent": this.userAgent,
        },
      });

      if (res.status === 429) {
        if (attempt >= this.maxRetries) {
          throw new DiscogsApiError("Discogs rate limit exceeded after retries", 429);
        }
        // Honour Retry-After (seconds) if the server sent one; else a fixed cooldown.
        const retryAfter = Number(res.headers.get("Retry-After"));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : RATELIMIT_COOLDOWN_MS;
        await this.sleep(wait);
        continue;
      }
      if (!res.ok) {
        throw new DiscogsApiError(`Discogs request failed (${res.status})`, res.status);
      }

      const body = (await res.json()) as T;
      // Stay a good citizen: if we're near the window edge, breathe before the next call.
      const remainingHeader = res.headers.get("X-Discogs-Ratelimit-Remaining");
      const remaining = remainingHeader === null ? NaN : Number(remainingHeader);
      if (Number.isFinite(remaining) && remaining <= RATELIMIT_LOW_WATERMARK) {
        await this.sleep(RATELIMIT_COOLDOWN_MS);
      }
      return body;
    }
  }
}

/**
 * Build the production adapter from environment config. Returns `null` (rather than
 * throwing) when credentials are absent, so callers can degrade gracefully — the sync
 * entrypoint reports a clear "set DISCOGS_* to sync" message instead of crashing.
 */
export function discogsAdapterFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  deps?: DiscogsAdapterDeps,
): HttpDiscogsAdapter | null {
  const username = env.DISCOGS_USERNAME?.trim();
  const token = env.DISCOGS_TOKEN?.trim();
  if (!username || !token) return null;
  // Coalesce an empty/whitespace override to undefined so the constructor falls back to the
  // descriptive DEFAULT_USER_AGENT. A blank User-Agent makes Discogs 403 (see DEFAULT_USER_AGENT),
  // and `.env.example` ships `DISCOGS_USER_AGENT=` empty — `"" ?? default` would keep the "".
  const userAgent = env.DISCOGS_USER_AGENT?.trim() || undefined;
  return new HttpDiscogsAdapter({ username, token, userAgent }, deps);
}
