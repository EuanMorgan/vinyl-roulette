/**
 * Real cross-source pricing (issue #6) behind the `PricingAdapter` seam from #2/#5.
 *
 * The picker (#5) consumes only the `PricingAdapter` interface and is **unchanged** by this
 * file: it asks for the listings of a chosen record and buys from the cheaper landed cost.
 * This slice swaps the fake (`FakePricingAdapter`) for the real thing — a lookup across
 * **Discogs Marketplace** (used/rare, condition-graded, per-seller shipping) and **Amazon**
 * (new repressings, Prime/free shipping), reporting **landed cost = item + shipping in pence
 * (GBP)** per source (CONTEXT.md → Catalog / Landed cost).
 *
 * ## Shape: a composite over per-source `PriceSource`s
 * `HttpPricingAdapter` holds one `PriceSource` per source and is deliberately dumb: it fans
 * `lookup` out to every source (tolerating one being down — a Discogs outage must not hide an
 * Amazon listing) and dispatches `revalidate` to whichever source owns the listing URL. All
 * the source-specific knowledge lives in the `PriceSource` implementations; all the
 * source-specific *parsing* lives in small pure functions (`parseDiscogsSellPage`,
 * `parseAmazonSearch`, …) that are unit-tested against fixtures. Network is an injected
 * `fetch`, exactly like `HttpDiscogsAdapter` — no live call in tests.
 *
 * ## Why HTML for some of it
 * Price is a **source-selector, not a record-selector** (CONTEXT.md): per source we only need
 * the cheapest *available* landed cost + a listing URL we can re-open and re-validate later.
 * Discogs's official API has **no endpoint that enumerates a release's marketplace listings**,
 * so `lookup` reads the public marketplace release page to find the cheapest listing (item +
 * shipping + condition). `revalidate`, by contrast, uses the official single-listing JSON
 * endpoint (`/marketplace/listings/{id}`), which is robust. Amazon has no free product API, so
 * both its calls parse HTML. The HTML parsers target today's public markup and are the
 * brittle, maintenance-prone part by design — isolated and fixture-tested so a markup change
 * is a localized fix. The injected-`fetch` seam also lets the transport be swapped later for a
 * Playwright-backed fetch (ADR-0003's real Chrome) without touching the parsing or the picker.
 */
import type { Source } from "@/store/types";
import type { PriceListing, PricingAdapter } from "./types";

const DEFAULT_USER_AGENT = "VinylRoulette/0.1 (+https://github.com/EuanMorgan/vinyl-autobuy)";
const DISCOGS_API = "https://api.discogs.com";
const DISCOGS_WEB = "https://www.discogs.com";
const AMAZON_WEB = "https://www.amazon.co.uk";

export interface AlbumQuery {
  artist: string;
  title: string;
}

/** Injectable side-effects so every source is testable without a network. */
export interface PricingDeps {
  fetch?: typeof fetch;
}

/**
 * One priced source (Discogs or Amazon). The composite owns no source-specific logic; it only
 * asks each source for its cheapest listing and routes `revalidate` by URL ownership.
 */
export interface PriceSource {
  readonly source: Source;
  /** The cheapest *available* listing for this album on this source, or null if none. */
  lookup(query: AlbumQuery): Promise<PriceListing | null>;
  /** Does this source own the given listing URL? (Routes `revalidate`.) */
  owns(listingUrl: string): boolean;
  /** Re-check a single listing live (ADR-0003 staleness): current landed cost, or null if gone. */
  revalidate(listingUrl: string): Promise<PriceListing | null>;
}

// ── Money helpers ───────────────────────────────────────────────────────────────

/**
 * Parse a GBP money string ("£12.34", "£1,234.56", "GBP 9.99") to pence. Returns null for
 * anything that isn't a clean GBP amount — a non-GBP price can't be compared on landed cost
 * without an FX table we deliberately don't carry, so it's treated as "no usable price".
 */
export function parseGbpToPence(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const text = raw.trim();
  // Reject obviously non-GBP currencies rather than silently misreading them as pounds.
  if (/[$€¥]/.test(text) || /\b(USD|EUR|JPY|CAD|AUD)\b/i.test(text)) return null;
  const match = text.match(/(\d[\d,]*)(?:\.(\d{1,2}))?/);
  if (!match) return null;
  const pounds = Number(match[1]!.replace(/,/g, ""));
  const fraction = match[2] ?? "";
  const pence = Number((fraction + "00").slice(0, 2));
  if (!Number.isFinite(pounds) || !Number.isFinite(pence)) return null;
  return pounds * 100 + pence;
}

/** Pick the cheapest available listing by landed cost (price is a source-selector). */
function cheapest(listings: PriceListing[]): PriceListing | null {
  return listings
    .filter((l) => l.available)
    .reduce<PriceListing | null>(
      (best, l) => (best && best.landedPricePence <= l.landedPricePence ? best : l),
      null,
    );
}

// ── Composite adapter ─────────────────────────────────────────────────────────────

/**
 * The real `PricingAdapter`: fans `lookup` across every source and returns each source's
 * cheapest listing, so the picker buys from the cheaper landed cost. A source that throws
 * (network down, markup changed) is skipped — its absence must never hide the other source.
 */
export class HttpPricingAdapter implements PricingAdapter {
  constructor(private readonly sources: PriceSource[]) {}

  async lookup(query: AlbumQuery): Promise<PriceListing[]> {
    const settled = await Promise.allSettled(this.sources.map((s) => s.lookup(query)));
    const listings: PriceListing[] = [];
    for (const result of settled) {
      if (result.status === "fulfilled" && result.value) listings.push(result.value);
    }
    return listings;
  }

  async revalidate(listingUrl: string): Promise<PriceListing | null> {
    const source = this.sources.find((s) => s.owns(listingUrl));
    if (!source) return null;
    try {
      return await source.revalidate(listingUrl);
    } catch {
      // A failed re-check is treated as "can't confirm" → null → the lifecycle marks it STALE
      // and re-picks (ADR-0003: never silently buy something we couldn't re-validate).
      return null;
    }
  }
}

// ── Discogs Marketplace source ──────────────────────────────────────────────────

export interface DiscogsPricingConfig {
  /** Personal access token — optional (public pages work) but lifts rate limits. */
  token?: string;
  userAgent?: string;
  apiBaseUrl?: string;
  webBaseUrl?: string;
}

/** One parsed marketplace listing row from a release's sell page. */
export interface ParsedDiscogsListing {
  listingId: number;
  itemPricePence: number;
  shippingPence: number;
  condition?: string;
}

/**
 * Parse a Discogs marketplace release sell page (`/sell/release/{id}`) into listings. Targets
 * the public markup: each listing links to `/sell/item/{listingId}`, carries a price and a
 * "+£x.xx shipping" note, and a media condition. Non-GBP prices are dropped (see
 * `parseGbpToPence`). Order is preserved; the source picks the cheapest landed afterwards.
 */
export function parseDiscogsSellPage(html: string): ParsedDiscogsListing[] {
  const listings: ParsedDiscogsListing[] = [];
  // Split on item anchors so each chunk is one listing's neighbourhood of markup.
  const itemRe = /\/sell\/item\/(\d+)/g;
  const anchors: { id: number; index: number }[] = [];
  for (let m = itemRe.exec(html); m; m = itemRe.exec(html)) {
    anchors.push({ id: Number(m[1]), index: m.index });
  }
  anchors.forEach((anchor, i) => {
    const chunk = html.slice(anchor.index, anchors[i + 1]?.index ?? html.length);
    const itemPricePence = parseGbpToPence(chunk.match(/£\s?[\d.,]+/)?.[0]);
    if (itemPricePence === null) return; // no usable GBP price → skip this listing
    const shippingMatch = chunk.match(/\+\s*£\s?([\d.,]+)\s*shipping/i);
    const shippingPence = shippingMatch ? (parseGbpToPence(shippingMatch[1]) ?? 0) : 0;
    const condition = chunk
      .match(/(Mint \(M\)|Near Mint \(NM or M-\)|Very Good Plus \(VG\+\)|Very Good \(VG\)|Good Plus \(G\+\)|Good \(G\)|Fair \(F\)|Poor \(P\))/)?.[1];
    listings.push({ listingId: anchor.id, itemPricePence, shippingPence, condition });
  });
  return listings;
}

/** Discogs single-listing JSON (the fields we read) — used by the robust `revalidate` path. */
interface DiscogsListingJson {
  status?: string; // "For Sale" when still buyable
  condition?: string;
  price?: { value?: number; currency?: string };
  shipping_price?: { value?: number; currency?: string };
}

interface DiscogsSearchJson {
  results?: { id?: number; type?: string }[];
}

/** Pull the numeric listing id out of a `/sell/item/{id}` URL. */
function discogsListingId(url: string): number | null {
  const m = url.match(/\/sell\/item\/(\d+)/);
  return m ? Number(m[1]) : null;
}

export class DiscogsMarketplaceSource implements PriceSource {
  readonly source = "discogs" as const;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private readonly apiBaseUrl: string;
  private readonly webBaseUrl: string;

  constructor(
    private readonly config: DiscogsPricingConfig = {},
    deps: PricingDeps = {},
  ) {
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.userAgent = config.userAgent ?? DEFAULT_USER_AGENT;
    this.apiBaseUrl = config.apiBaseUrl ?? DISCOGS_API;
    this.webBaseUrl = config.webBaseUrl ?? DISCOGS_WEB;
  }

  owns(listingUrl: string): boolean {
    return /(^|\.)discogs\.com/.test(safeHost(listingUrl));
  }

  async lookup(query: AlbumQuery): Promise<PriceListing | null> {
    const releaseId = await this.resolveReleaseId(query);
    if (releaseId === null) return null;

    const html = await this.getText(
      `${this.webBaseUrl}/sell/release/${releaseId}?format=Vinyl&currency=GBP&sort=price&limit=50`,
    );
    const parsed = parseDiscogsSellPage(html);
    const listings: PriceListing[] = parsed.map((l) => ({
      source: this.source,
      listingUrl: `${this.webBaseUrl}/sell/item/${l.listingId}`,
      landedPricePence: l.itemPricePence + l.shippingPence,
      shippingPence: l.shippingPence,
      condition: l.condition,
      available: true,
      discogsReleaseId: releaseId,
    }));
    return cheapest(listings);
  }

  async revalidate(listingUrl: string): Promise<PriceListing | null> {
    const id = discogsListingId(listingUrl);
    if (id === null) return null;
    const res = await this.fetchImpl(`${this.apiBaseUrl}/marketplace/listings/${id}?curr_abbr=GBP`, {
      headers: this.headers(),
    });
    if (res.status === 404) return null; // listing sold/removed → gone
    if (!res.ok) throw new Error(`Discogs listing ${id} re-check failed (${res.status})`);
    const body = (await res.json()) as DiscogsListingJson;
    if (body.status && body.status !== "For Sale") return null; // no longer buyable → gone
    const itemPence = gbpValueToPence(body.price);
    if (itemPence === null) return null;
    const shippingPence = gbpValueToPence(body.shipping_price) ?? 0;
    return {
      source: this.source,
      listingUrl,
      landedPricePence: itemPence + shippingPence,
      shippingPence,
      condition: body.condition,
      available: true,
    };
  }

  /** Resolve the most relevant Vinyl release id for an album via the official search API. */
  private async resolveReleaseId(query: AlbumQuery): Promise<number | null> {
    const params = new URLSearchParams({
      artist: query.artist,
      release_title: query.title,
      type: "release",
      format: "Vinyl",
      per_page: "5",
    });
    if (this.config.token) params.set("token", this.config.token);
    const res = await this.fetchImpl(`${this.apiBaseUrl}/database/search?${params.toString()}`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`Discogs search failed (${res.status})`);
    const body = (await res.json()) as DiscogsSearchJson;
    const first = body.results?.find((r) => r.type === "release" && typeof r.id === "number");
    return first?.id ?? null;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "User-Agent": this.userAgent };
    if (this.config.token) h.Authorization = `Discogs token=${this.config.token}`;
    return h;
  }

  private async getText(url: string): Promise<string> {
    const res = await this.fetchImpl(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`Discogs page fetch failed (${res.status}) for ${url}`);
    return res.text();
  }
}

function gbpValueToPence(money: { value?: number; currency?: string } | undefined): number | null {
  if (!money || typeof money.value !== "number") return null;
  if (money.currency && money.currency !== "GBP") return null;
  return Math.round(money.value * 100);
}

// ── Amazon source ─────────────────────────────────────────────────────────────────

export interface AmazonPricingConfig {
  userAgent?: string;
  baseUrl?: string;
}

/** First plausible search result: its ASIN + GBP price in pence. */
export interface ParsedAmazonResult {
  asin: string;
  pricePence: number;
}

/**
 * Parse an Amazon search results page for the first result that carries both an ASIN and a
 * GBP price. Targets `data-asin="..."` result blocks with an `.a-offscreen` price span.
 */
export function parseAmazonSearch(html: string): ParsedAmazonResult | null {
  const blockRe = /data-asin="([A-Z0-9]{10})"([\s\S]*?)(?=data-asin="[A-Z0-9]{10}"|$)/g;
  for (let m = blockRe.exec(html); m; m = blockRe.exec(html)) {
    const asin = m[1]!;
    const offscreen = m[2]!.match(/class="a-offscreen">([^<]+)</);
    const pricePence = parseGbpToPence(offscreen?.[1]);
    if (pricePence !== null) return { asin, pricePence };
  }
  return null;
}

/** Parse an Amazon product page for current price + in-stock availability. */
export function parseAmazonProduct(html: string): { pricePence: number; available: boolean } | null {
  const pricePence = parseGbpToPence(html.match(/class="a-offscreen">([^<]+)</)?.[1]);
  if (pricePence === null) return null;
  // Treat as available unless the page clearly says otherwise.
  const unavailable = /currently unavailable|out of stock/i.test(html);
  return { pricePence, available: !unavailable };
}

export class AmazonSource implements PriceSource {
  readonly source = "amazon" as const;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private readonly baseUrl: string;

  constructor(
    config: AmazonPricingConfig = {},
    deps: PricingDeps = {},
  ) {
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.userAgent = config.userAgent ?? DEFAULT_USER_AGENT;
    this.baseUrl = config.baseUrl ?? AMAZON_WEB;
  }

  owns(listingUrl: string): boolean {
    return /(^|\.)amazon\./.test(safeHost(listingUrl));
  }

  async lookup(query: AlbumQuery): Promise<PriceListing | null> {
    const search = new URLSearchParams({ k: `${query.artist} ${query.title} vinyl LP`, i: "music" });
    const html = await this.getText(`${this.baseUrl}/s?${search.toString()}`);
    const result = parseAmazonSearch(html);
    if (!result) return null;
    // A priced search hit is treated as available; the search page doesn't reliably expose
    // per-result stock. The product-page `revalidate` (which DOES read availability) is the
    // backstop — an out-of-stock hit can't actually be bought, it re-checks to STALE → re-pick.
    return {
      source: this.source,
      listingUrl: `${this.baseUrl}/dp/${result.asin}`,
      // Amazon repressings ship Prime/free, so landed == item price (shipping 0). If a future
      // parse surfaces a shipping line it should be added here.
      landedPricePence: result.pricePence,
      shippingPence: 0,
      available: true,
    };
  }

  async revalidate(listingUrl: string): Promise<PriceListing | null> {
    const html = await this.getText(listingUrl);
    const product = parseAmazonProduct(html);
    if (!product || !product.available) return null;
    return {
      source: this.source,
      listingUrl,
      landedPricePence: product.pricePence,
      shippingPence: 0,
      available: true,
    };
  }

  private async getText(url: string): Promise<string> {
    const res = await this.fetchImpl(url, { headers: { "User-Agent": this.userAgent } });
    if (!res.ok) throw new Error(`Amazon fetch failed (${res.status}) for ${url}`);
    return res.text();
  }
}

// ── Construction from env ─────────────────────────────────────────────────────────

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/**
 * Build the production pricing adapter from environment config. Always returns an adapter:
 * both sources have public defaults (Discogs marketplace pages and Amazon search are public),
 * and a `DISCOGS_TOKEN`, when present, only lifts Discogs rate limits. Source URLs/locale can
 * be overridden for a non-UK Amazon or for tests.
 */
export function pricingAdapterFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  deps?: PricingDeps,
): HttpPricingAdapter {
  const userAgent = env.DISCOGS_USER_AGENT?.trim() || undefined;
  const discogs = new DiscogsMarketplaceSource(
    { token: env.DISCOGS_TOKEN?.trim() || undefined, userAgent },
    deps,
  );
  const amazon = new AmazonSource({ baseUrl: env.AMAZON_BASE_URL?.trim() || undefined }, deps);
  return new HttpPricingAdapter([discogs, amazon]);
}
