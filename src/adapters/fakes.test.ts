import { describe, it, expect } from "vitest";
import { FakeBuyAdapter, FakeDiscogsAdapter, FakePricingAdapter } from "./fakes";

describe("adapter fakes (the documented faking pattern)", () => {
  it("FakeDiscogsAdapter returns its canned collection", async () => {
    const discogs = new FakeDiscogsAdapter([
      { artist: "The Beatles", title: "Abbey Road", discogsInstanceId: 1 },
    ]);
    expect(await discogs.fetchCollection()).toHaveLength(1);
  });

  it("FakePricingAdapter serves listings and selects on the seam, not the network", async () => {
    const pricing = new FakePricingAdapter();
    pricing.setListings("Miles Davis", "Kind of Blue", [
      { source: "discogs", listingUrl: "https://d/x", landedPricePence: 2200, available: true },
      { source: "amazon", listingUrl: "https://a/y", landedPricePence: 2500, available: true },
    ]);
    const listings = await pricing.lookup({ artist: "miles davis", title: "KIND OF BLUE" });
    const cheapest = listings.reduce((a, b) =>
      a.landedPricePence <= b.landedPricePence ? a : b,
    );
    expect(cheapest.source).toBe("discogs");
  });

  it("FakePricingAdapter models a gone listing and a price drift (ADR-0003)", async () => {
    const pricing = new FakePricingAdapter();
    pricing.setListings("X", "Y", [
      { source: "amazon", listingUrl: "https://a/y", landedPricePence: 2500, available: true },
    ]);
    pricing.setDriftedPrice("https://a/y", 2900);
    expect((await pricing.revalidate("https://a/y"))?.landedPricePence).toBe(2900);

    pricing.markGone("https://a/y");
    expect(await pricing.revalidate("https://a/y")).toBeNull();
  });

  it("FakeBuyAdapter records prepare/pay and can be forced to fail", async () => {
    const buy = new FakeBuyAdapter();
    const quote = { source: "discogs" as const, listingUrl: "https://d/x", expectedPricePence: 2200 };
    expect((await buy.prepare(quote)).ready).toBe(true);
    const result = await buy.pay(quote);
    expect(result.ok).toBe(true);
    expect(result.finalPricePence).toBe(2200);
    expect(buy.prepared).toHaveLength(1);
    expect(buy.paid).toHaveLength(1);

    buy.payError = "card declined";
    expect((await buy.pay(quote)).ok).toBe(false);
  });
});
