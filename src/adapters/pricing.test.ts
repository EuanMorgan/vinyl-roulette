import { describe, it, expect } from "vitest";
import {
  AmazonSource,
  DiscogsMarketplaceSource,
  HttpPricingAdapter,
  parseAmazonProduct,
  parseAmazonSearch,
  parseDiscogsSellPage,
  parseGbpToPence,
  pricingAdapterFromEnv,
  type PriceSource,
} from "./pricing";
import type { AlbumQuery } from "./pricing";
import type { PriceListing } from "./types";

/**
 * Exercises the real pricing adapter at its seam: the deterministic composite logic (cheaper
 * source wins, one source failing doesn't hide the other, revalidate routed by URL) and the
 * brittle per-source HTML/JSON parsing — all with an injected `fetch` and canned fixtures, no
 * live Discogs/Amazon call (mirrors `discogs.test.ts`).
 */

/** A fetch stand-in that matches request URLs against `routes` (first substring hit wins). */
function routedFetch(routes: { match: string; status?: number; text?: string; json?: unknown }[]) {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    const route = routes.find((r) => url.includes(r.match));
    const status = route?.status ?? (route ? 200 : 404);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => route?.text ?? "",
      json: async () => route?.json ?? {},
    };
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const QUERY: AlbumQuery = { artist: "Miles Davis", title: "Kind of Blue" };

describe("parseGbpToPence", () => {
  it("parses plain, penced, and thousands-separated GBP", () => {
    expect(parseGbpToPence("£12.34")).toBe(1234);
    expect(parseGbpToPence("£9")).toBe(900);
    expect(parseGbpToPence("£1,234.50")).toBe(123450);
    expect(parseGbpToPence("GBP 9.99")).toBe(999);
    expect(parseGbpToPence("£7.5")).toBe(750); // single-digit pence padded
  });
  it("rejects non-GBP and junk (no FX table — can't compare landed cost)", () => {
    expect(parseGbpToPence("$12.34")).toBeNull();
    expect(parseGbpToPence("€10.00")).toBeNull();
    expect(parseGbpToPence("USD 9.99")).toBeNull();
    expect(parseGbpToPence("")).toBeNull();
    expect(parseGbpToPence(undefined)).toBeNull();
  });
});

describe("parseDiscogsSellPage", () => {
  const html = `
    <table>
      <tr><a href="/sell/item/111">view</a> <span>£12.00</span> +£3.50 shipping
        <span>Near Mint (NM or M-)</span></tr>
      <tr><a href="/sell/item/222">view</a> <span>£8.00</span> +£5.00 shipping
        <span>Very Good Plus (VG+)</span></tr>
      <tr><a href="/sell/item/333">view</a> <span>$20.00</span> +$2.00 shipping
        <span>Mint (M)</span></tr>
    </table>`;

  it("extracts item price, shipping and condition per listing", () => {
    const listings = parseDiscogsSellPage(html);
    expect(listings).toEqual([
      { listingId: 111, itemPricePence: 1200, shippingPence: 350, condition: "Near Mint (NM or M-)" },
      { listingId: 222, itemPricePence: 800, shippingPence: 500, condition: "Very Good Plus (VG+)" },
    ]);
  });
  it("drops non-GBP listings rather than misreading them", () => {
    expect(parseDiscogsSellPage(html).some((l) => l.listingId === 333)).toBe(false);
  });
});

describe("parseAmazonSearch / parseAmazonProduct", () => {
  it("returns the first result with an ASIN and a GBP price", () => {
    const html = `
      <div data-asin="">sponsored slot, no asin</div>
      <div data-asin="B000000001"><span class="a-offscreen">£24.99</span></div>
      <div data-asin="B000000002"><span class="a-offscreen">£19.99</span></div>`;
    expect(parseAmazonSearch(html)).toEqual({ asin: "B000000001", pricePence: 2499 });
  });
  it("returns null when no result has a GBP price", () => {
    expect(parseAmazonSearch(`<div data-asin="B000000001">no price</div>`)).toBeNull();
  });
  it("reads product price + availability", () => {
    expect(parseAmazonProduct(`<span class="a-offscreen">£21.50</span> In stock`)).toEqual({
      pricePence: 2150,
      available: true,
    });
    expect(
      parseAmazonProduct(`<span class="a-offscreen">£21.50</span> Currently unavailable`),
    ).toEqual({ pricePence: 2150, available: false });
  });
});

describe("DiscogsMarketplaceSource", () => {
  const sellPage = `<a href="/sell/item/111">x</a> £12.00 +£3.50 shipping Near Mint (NM or M-)
    <a href="/sell/item/222">y</a> £8.00 +£1.00 shipping Very Good Plus (VG+)`;

  it("resolves a release then returns the cheapest landed listing", async () => {
    const f = routedFetch([
      { match: "/database/search", json: { results: [{ id: 555, type: "release" }] } },
      { match: "/sell/release/555", text: sellPage },
    ]);
    const src = new DiscogsMarketplaceSource({}, { fetch: f.fn });
    const listing = await src.lookup(QUERY);
    // £8.00 + £1.00 = £9.00 landed beats £12.00 + £3.50 = £15.50.
    expect(listing).toMatchObject({
      source: "discogs",
      listingUrl: "https://www.discogs.com/sell/item/222",
      landedPricePence: 900,
      shippingPence: 100,
      condition: "Very Good Plus (VG+)",
      available: true,
      discogsReleaseId: 555,
    });
  });

  it("returns null when the album isn't found", async () => {
    const f = routedFetch([{ match: "/database/search", json: { results: [] } }]);
    const src = new DiscogsMarketplaceSource({}, { fetch: f.fn });
    expect(await src.lookup(QUERY)).toBeNull();
  });

  it("revalidates a live listing via the official single-listing endpoint", async () => {
    const f = routedFetch([
      {
        match: "/marketplace/listings/222",
        json: {
          status: "For Sale",
          condition: "Very Good Plus (VG+)",
          price: { value: 8, currency: "GBP" },
          shipping_price: { value: 1, currency: "GBP" },
        },
      },
    ]);
    const src = new DiscogsMarketplaceSource({}, { fetch: f.fn });
    const listing = await src.revalidate("https://www.discogs.com/sell/item/222");
    expect(listing).toMatchObject({ landedPricePence: 900, shippingPence: 100, available: true });
  });

  it("treats a 404 or sold listing as gone (null)", async () => {
    const gone = routedFetch([{ match: "/marketplace/listings/222", status: 404 }]);
    expect(
      await new DiscogsMarketplaceSource({}, { fetch: gone.fn }).revalidate(
        "https://www.discogs.com/sell/item/222",
      ),
    ).toBeNull();

    const sold = routedFetch([
      { match: "/marketplace/listings/222", json: { status: "Sold", price: { value: 8 } } },
    ]);
    expect(
      await new DiscogsMarketplaceSource({}, { fetch: sold.fn }).revalidate(
        "https://www.discogs.com/sell/item/222",
      ),
    ).toBeNull();
  });

  it("sends the token as auth + query param when configured", async () => {
    const f = routedFetch([
      { match: "/database/search", json: { results: [{ id: 1, type: "release" }] } },
      { match: "/sell/release/1", text: "£5.00" },
    ]);
    await new DiscogsMarketplaceSource({ token: "secret" }, { fetch: f.fn }).lookup(QUERY);
    expect(f.calls[0]).toContain("token=secret");
  });
});

describe("AmazonSource", () => {
  it("returns a product listing (Prime/free shipping → landed == item)", async () => {
    const f = routedFetch([
      { match: "/s?", text: `<div data-asin="B000000001"><span class="a-offscreen">£24.99</span></div>` },
    ]);
    const src = new AmazonSource({}, { fetch: f.fn });
    const listing = await src.lookup(QUERY);
    expect(listing).toMatchObject({
      source: "amazon",
      listingUrl: "https://www.amazon.co.uk/dp/B000000001",
      landedPricePence: 2499,
      shippingPence: 0,
      available: true,
    });
  });

  it("revalidate returns null for an unavailable product", async () => {
    const f = routedFetch([
      { match: "/dp/B1", text: `<span class="a-offscreen">£24.99</span> Currently unavailable` },
    ]);
    expect(await new AmazonSource({}, { fetch: f.fn }).revalidate("https://www.amazon.co.uk/dp/B1")).toBeNull();
  });
});

describe("HttpPricingAdapter (composite)", () => {
  function fakeSource(source: PriceSource["source"], listing: PriceListing | null, host: string): PriceSource {
    return {
      source,
      async lookup() {
        return listing;
      },
      owns(url) {
        return url.includes(host);
      },
      async revalidate() {
        return listing;
      },
    };
  }

  it("returns one listing per source so the picker can pick the cheaper landed cost", async () => {
    const discogs: PriceListing = { source: "discogs", listingUrl: "https://www.discogs.com/sell/item/1", landedPricePence: 900, available: true };
    const amazon: PriceListing = { source: "amazon", listingUrl: "https://www.amazon.co.uk/dp/A", landedPricePence: 2499, available: true };
    const adapter = new HttpPricingAdapter([
      fakeSource("discogs", discogs, "discogs.com"),
      fakeSource("amazon", amazon, "amazon."),
    ]);
    const listings = await adapter.lookup(QUERY);
    expect(listings).toEqual([discogs, amazon]);
  });

  it("a source that throws does not hide the other source's listing", async () => {
    const amazon: PriceListing = { source: "amazon", listingUrl: "https://www.amazon.co.uk/dp/A", landedPricePence: 2499, available: true };
    const failing: PriceSource = {
      source: "discogs",
      async lookup() {
        throw new Error("discogs down");
      },
      owns: () => false,
      async revalidate() {
        return null;
      },
    };
    const adapter = new HttpPricingAdapter([failing, fakeSource("amazon", amazon, "amazon.")]);
    expect(await adapter.lookup(QUERY)).toEqual([amazon]);
  });

  it("routes revalidate to the owning source by URL", async () => {
    const amazon: PriceListing = { source: "amazon", listingUrl: "https://www.amazon.co.uk/dp/A", landedPricePence: 2499, available: true };
    const adapter = new HttpPricingAdapter([
      fakeSource("discogs", null, "discogs.com"),
      fakeSource("amazon", amazon, "amazon."),
    ]);
    expect(await adapter.revalidate("https://www.amazon.co.uk/dp/A")).toEqual(amazon);
    expect(await adapter.revalidate("https://unknown.example/x")).toBeNull();
  });

  it("a thrown revalidate becomes null (→ lifecycle marks STALE, never a silent buy)", async () => {
    const throwing: PriceSource = {
      source: "discogs",
      async lookup() {
        return null;
      },
      owns: () => true,
      async revalidate() {
        throw new Error("boom");
      },
    };
    expect(await new HttpPricingAdapter([throwing]).revalidate("https://www.discogs.com/sell/item/1")).toBeNull();
  });
});

describe("pricingAdapterFromEnv", () => {
  it("builds a Discogs + Amazon adapter that the picker can consume", async () => {
    const f = routedFetch([
      { match: "/database/search", json: { results: [{ id: 7, type: "release" }] } },
      { match: "/sell/release/7", text: `<a href="/sell/item/9">x</a> £10.00 +£0.00 shipping Mint (M)` },
      { match: "/s?", text: `<div data-asin="B000000009"><span class="a-offscreen">£12.00</span></div>` },
    ]);
    const env = { AMAZON_BASE_URL: "https://www.amazon.co.uk" } as unknown as NodeJS.ProcessEnv;
    const adapter = pricingAdapterFromEnv(env, { fetch: f.fn });
    const listings = await adapter.lookup(QUERY);
    const bySource = Object.fromEntries(listings.map((l) => [l.source, l.landedPricePence]));
    expect(bySource).toEqual({ discogs: 1000, amazon: 1200 });
  });
});
