/**
 * The Splurge picker as a PURE DECISION FUNCTION (issue #8) — the second buy intent competing
 * for the monthly slot. It raids the Rejected log (the Splurge wishlist) for a pricey record a
 * fat war chest can now clear, re-prices it live, and buys from the cheaper source. The
 * load-bearing rule asserted here: it fires *only* when the chest can clear a wishlist item
 * under the per-purchase ceiling — never overspending the balance or the ceiling.
 */
import { describe, it, expect } from "vitest";
import { FakePricingAdapter } from "@/adapters/fakes";
import type { PriceListing } from "@/adapters/types";
import { albumKey } from "@/store/types";
import { pickSplurge, type SplurgeCandidate } from "./splurge";

function avail(source: "discogs" | "amazon", pence: number, url: string): PriceListing {
  return { source, listingUrl: url, landedPricePence: pence, available: true };
}

function candidate(artist: string, title: string, quotedPricePence: number): SplurgeCandidate {
  return { album_key: albumKey(artist, title), artist, title, lane: "stretch", quotedPricePence };
}

describe("pickSplurge", () => {
  it("clears the priciest affordable wishlist item, buying from the cheaper source", async () => {
    const pricing = new FakePricingAdapter();
    pricing.setListings("John Coltrane", "A Love Supreme", [
      avail("amazon", 4800, "https://a/als"),
      avail("discogs", 4500, "https://d/als"),
    ]);
    const result = await pickSplurge({
      pricing,
      candidates: [candidate("John Coltrane", "A Love Supreme", 5200)],
      ownedKeys: new Set(),
      budget: { balancePence: 9000, ceilingPence: 6000 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.quote.title).toBe("A Love Supreme");
      expect(result.quote.source).toBe("discogs");
      expect(result.quote.landedPricePence).toBe(4500);
      expect(result.quote.lane).toBe("stretch"); // the originating Lane is carried to the Reveal
    }
  });

  it("never proposes over the per-purchase ceiling even when the balance could cover it", async () => {
    const pricing = new FakePricingAdapter();
    pricing.setListings("John Coltrane", "A Love Supreme", [avail("discogs", 6500, "https://d/als")]);
    const result = await pickSplurge({
      pricing,
      candidates: [candidate("John Coltrane", "A Love Supreme", 6500)],
      ownedKeys: new Set(),
      // Balance is fat (£90) but the ceiling (£60) is the hard cap on any single buy.
      budget: { balancePence: 9000, ceilingPence: 6000 },
    });
    expect(result.ok).toBe(false);
  });

  it("never proposes over the balance even when under the ceiling", async () => {
    const pricing = new FakePricingAdapter();
    pricing.setListings("John Coltrane", "A Love Supreme", [avail("discogs", 5000, "https://d/als")]);
    const result = await pickSplurge({
      pricing,
      candidates: [candidate("John Coltrane", "A Love Supreme", 5000)],
      ownedKeys: new Set(),
      budget: { balancePence: 4000, ceilingPence: 6000 },
    });
    expect(result.ok).toBe(false);
  });

  it("skips an unaffordable priciest pick and lands a cheaper one further down", async () => {
    const pricing = new FakePricingAdapter();
    pricing.setListings("Pricey", "Out of Reach", [avail("discogs", 9000, "https://d/p")]);
    pricing.setListings("Wings", "Band on the Run", [avail("discogs", 2500, "https://d/w")]);
    const result = await pickSplurge({
      pricing,
      candidates: [
        candidate("Pricey", "Out of Reach", 9000),
        candidate("Wings", "Band on the Run", 2500),
      ],
      ownedKeys: new Set(),
      budget: { balancePence: 4000, ceilingPence: 6000 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.quote.title).toBe("Band on the Run");
  });

  it("skips a wishlist item that is now owned, never re-buying it", async () => {
    const pricing = new FakePricingAdapter();
    pricing.setListings("Wings", "Band on the Run", [avail("discogs", 2500, "https://d/w")]);
    const result = await pickSplurge({
      pricing,
      candidates: [candidate("Wings", "Band on the Run", 2500)],
      ownedKeys: new Set([albumKey("Wings", "Band on the Run")]),
      budget: { balancePence: 9000, ceilingPence: 6000 },
    });
    expect(result.ok).toBe(false);
  });

  it("skips a wishlist item whose listing is now gone", async () => {
    const pricing = new FakePricingAdapter(); // no listings set → lookup returns []
    const result = await pickSplurge({
      pricing,
      candidates: [candidate("Wings", "Band on the Run", 2500)],
      ownedKeys: new Set(),
      budget: { balancePence: 9000, ceilingPence: 6000 },
    });
    expect(result.ok).toBe(false);
  });
});
