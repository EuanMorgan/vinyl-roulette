/**
 * The picker is the project's PRIMARY test seam (PRD → Testing Decisions). These tests
 * assert the *rules around* the chaos, never the chaos itself:
 *
 *   - the chosen record under multi-lane weighting is non-deterministic by design and is
 *     NEVER asserted;
 *   - the rules (never an owned album, never over balance/ceiling, loops past an
 *     unaffordable pick, a weighted-to-1 lane wins, a stretch on-ramp surfaces) ARE.
 *
 * Everything external is faked at its boundary: the Brain (Claude's in-context proposal)
 * and the cross-source pricing lookup. With a fixed seed and faked adapters, `pickRecord`
 * is a fully deterministic pure function.
 */
import { describe, it, expect } from "vitest";
import { FakeBrainAdapter, FakePricingAdapter } from "@/adapters/fakes";
import type { BrainCandidate, BrainContext, PriceListing } from "@/adapters/types";
import { pickRecord, type PickerInput } from "./picker";

function listing(source: "discogs" | "amazon", pence: number, url: string): PriceListing {
  return { source, listingUrl: url, landedPricePence: pence, available: true };
}

interface Scenario {
  candidates: BrainCandidate[];
  /** Listings keyed by `${artist}::${title}`. */
  prices?: Record<string, PriceListing[]>;
  owned?: BrainContext["owned"];
  rejectedKeys?: string[];
  chaosDial?: BrainContext["chaosDial"];
  balancePence?: number;
  ceilingPence?: number;
  seed?: number;
}

function makeInput(s: Scenario): PickerInput {
  const brain = new FakeBrainAdapter(s.candidates);
  const pricing = new FakePricingAdapter();
  for (const [k, listings] of Object.entries(s.prices ?? {})) {
    const [artist = "", title = ""] = k.split("::");
    pricing.setListings(artist, title, listings);
  }
  return {
    brain,
    pricing,
    taste: {
      owned: s.owned ?? [],
      rejectedKeys: s.rejectedKeys ?? [],
      chaosDial: s.chaosDial ?? { complete: 1, adjacent: 0, stretch: 0 },
    },
    budget: { balancePence: s.balancePence ?? 3000, ceilingPence: s.ceilingPence ?? 6000 },
    seed: s.seed ?? 42,
  };
}

describe("pickRecord — the pure decision function", () => {
  it("never proposes an album already in the Owned set", async () => {
    const result = await pickRecord(
      makeInput({
        candidates: [
          { artist: "The Beatles", title: "Abbey Road", lane: "complete", why: "owned dupe" },
          { artist: "The Beatles", title: "Let It Be", lane: "complete", why: "completes the set" },
        ],
        owned: [{ artist: "The Beatles", title: "Abbey Road" }],
        prices: {
          "The Beatles::Abbey Road": [listing("discogs", 1500, "https://d/owned")],
          "The Beatles::Let It Be": [listing("discogs", 2000, "https://d/letitbe")],
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.quote.title).toBe("Let It Be");
  });

  it("skips candidates already in the Rejected log", async () => {
    const result = await pickRecord(
      makeInput({
        candidates: [
          { artist: "Pixies", title: "Doolittle", lane: "adjacent", why: "tried before" },
          { artist: "Wings", title: "Band on the Run", lane: "adjacent", why: "fresh" },
        ],
        chaosDial: { complete: 0, adjacent: 1, stretch: 0 },
        rejectedKeys: ["pixies|doolittle"],
        prices: {
          "Pixies::Doolittle": [listing("discogs", 2000, "https://d/pixies")],
          "Wings::Band on the Run": [listing("discogs", 2000, "https://d/wings")],
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.quote.title).toBe("Band on the Run");
  });

  it("never quotes over the balance", async () => {
    const result = await pickRecord(
      makeInput({
        candidates: [{ artist: "Can", title: "Tago Mago", lane: "stretch", why: "krautrock" }],
        chaosDial: { complete: 0, adjacent: 0, stretch: 1 },
        balancePence: 3000,
        ceilingPence: 6000,
        prices: { "Can::Tago Mago": [listing("discogs", 5000, "https://d/can")] },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]).toMatchObject({ title: "Tago Mago", reason: "over_budget" });
  });

  it("never quotes over the per-purchase ceiling even when the balance is fat", async () => {
    const result = await pickRecord(
      makeInput({
        candidates: [{ artist: "Can", title: "Tago Mago", lane: "stretch", why: "krautrock" }],
        chaosDial: { complete: 0, adjacent: 0, stretch: 1 },
        balancePence: 10000,
        ceilingPence: 4000,
        prices: { "Can::Tago Mago": [listing("discogs", 5000, "https://d/can")] },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.rejected[0]).toMatchObject({ reason: "over_budget" });
  });

  it("loops past an unaffordable pick to a cheaper one, logging the reject", async () => {
    const result = await pickRecord(
      makeInput({
        candidates: [
          { artist: "Rare Press", title: "Expensive", lane: "complete", why: "want most" },
          { artist: "Common Press", title: "Affordable", lane: "complete", why: "second choice" },
        ],
        balancePence: 3000,
        ceilingPence: 6000,
        prices: {
          "Rare Press::Expensive": [listing("discogs", 9000, "https://d/rare")],
          "Common Press::Affordable": [listing("discogs", 2000, "https://d/common")],
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.quote.title).toBe("Affordable");
    expect(result.rejected).toEqual([
      expect.objectContaining({
        title: "Expensive",
        reason: "over_budget",
        quotedPricePence: 9000,
        listingUrl: "https://d/rare",
      }),
    ]);
  });

  it("loops past an out-of-stock pick, logging it as out_of_stock", async () => {
    const result = await pickRecord(
      makeInput({
        candidates: [
          { artist: "Sold Out", title: "Gone", lane: "complete", why: "want most" },
          { artist: "In Stock", title: "Here", lane: "complete", why: "backup" },
        ],
        prices: {
          // no listings at all for "Gone" → out of stock
          "In Stock::Here": [listing("discogs", 2000, "https://d/here")],
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.quote.title).toBe("Here");
    expect(result.rejected[0]).toMatchObject({ title: "Gone", reason: "out_of_stock" });
  });

  it("treats listings marked unavailable as out of stock", async () => {
    const result = await pickRecord(
      makeInput({
        candidates: [{ artist: "Maybe", title: "Nope", lane: "complete", why: "x" }],
        prices: {
          "Maybe::Nope": [
            { source: "discogs", listingUrl: "https://d/x", landedPricePence: 2000, available: false },
          ],
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.rejected[0]).toMatchObject({ reason: "out_of_stock" });
  });

  it("buys from whichever source has the lower landed cost", async () => {
    const result = await pickRecord(
      makeInput({
        candidates: [{ artist: "Miles Davis", title: "Kind of Blue", lane: "stretch", why: "jazz" }],
        chaosDial: { complete: 0, adjacent: 0, stretch: 1 },
        prices: {
          "Miles Davis::Kind of Blue": [
            listing("amazon", 2500, "https://a/kob"),
            listing("discogs", 2200, "https://d/kob"),
          ],
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.quote.source).toBe("discogs");
      expect(result.quote.landedPricePence).toBe(2200);
    }
  });

  it("returns a canonical Stretch on-ramp for a genre the Owned set lacks", async () => {
    // chaos dial pinned to Stretch removes lane randomness; the Brain (faked) is the source
    // of the canonical on-ramp. We assert the rule — Stretch surfaces the on-ramp the Brain
    // supplied for an empty genre — not a random record.
    const brain = new FakeBrainAdapter([
      { artist: "Miles Davis", title: "Kind of Blue", lane: "stretch", why: "the jazz on-ramp" },
    ]);
    const pricing = new FakePricingAdapter();
    pricing.setListings("Miles Davis", "Kind of Blue", [listing("discogs", 2400, "https://d/kob")]);
    const input: PickerInput = {
      brain,
      pricing,
      taste: {
        owned: [
          { artist: "The Beatles", title: "Abbey Road", genres: ["Rock"] },
          { artist: "Nas", title: "Illmatic", genres: ["Hip Hop"] },
        ],
        rejectedKeys: [],
        chaosDial: { complete: 0, adjacent: 0, stretch: 1 },
      },
      budget: { balancePence: 3000, ceilingPence: 6000 },
      seed: 7,
    };
    const result = await pickRecord(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.quote.lane).toBe("stretch");
      expect(result.quote.title).toBe("Kind of Blue");
      expect(result.quote.why).toContain("on-ramp");
    }
    // the Brain reasoned over the real Owned set (no jazz present)
    expect(brain.lastContext?.owned).toHaveLength(2);
  });

  it("returns nothing-affordable when the Brain proposes nothing", async () => {
    const result = await pickRecord(makeInput({ candidates: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("nothing_affordable");
    expect(result.rejected).toEqual([]);
  });

  it("returns nothing-affordable when every candidate is over budget", async () => {
    const result = await pickRecord(
      makeInput({
        candidates: [
          { artist: "A", title: "One", lane: "complete", why: "x" },
          { artist: "B", title: "Two", lane: "complete", why: "y" },
        ],
        balancePence: 1000,
        prices: {
          "A::One": [listing("discogs", 5000, "https://d/1")],
          "B::Two": [listing("discogs", 6000, "https://d/2")],
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.rejected).toHaveLength(2);
  });

  it("the lane weighted to 1 is the lane that wins (rule, not record)", async () => {
    // One affordable candidate per lane; with stretch weighted to 1 the winner is the
    // stretch candidate — asserting lane routing, never which specific record.
    const result = await pickRecord(
      makeInput({
        candidates: [
          { artist: "C", title: "Complete Pick", lane: "complete", why: "c" },
          { artist: "A", title: "Adjacent Pick", lane: "adjacent", why: "a" },
          { artist: "S", title: "Stretch Pick", lane: "stretch", why: "s" },
        ],
        chaosDial: { complete: 0, adjacent: 0, stretch: 1 },
        prices: {
          "C::Complete Pick": [listing("discogs", 2000, "https://d/c")],
          "A::Adjacent Pick": [listing("discogs", 2000, "https://d/a")],
          "S::Stretch Pick": [listing("discogs", 2000, "https://d/s")],
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.quote.lane).toBe("stretch");
  });

  it("is deterministic: same seed + inputs → identical result", async () => {
    const scenario: Scenario = {
      candidates: [
        { artist: "C", title: "Complete Pick", lane: "complete", why: "c" },
        { artist: "A", title: "Adjacent Pick", lane: "adjacent", why: "a" },
        { artist: "S", title: "Stretch Pick", lane: "stretch", why: "s" },
      ],
      chaosDial: { complete: 0.5, adjacent: 0.35, stretch: 0.15 },
      seed: 12345,
      prices: {
        "C::Complete Pick": [listing("discogs", 2000, "https://d/c")],
        "A::Adjacent Pick": [listing("discogs", 2000, "https://d/a")],
        "S::Stretch Pick": [listing("discogs", 2000, "https://d/s")],
      },
    };
    const a = await pickRecord(makeInput(scenario));
    const b = await pickRecord(makeInput(scenario));
    expect(a).toEqual(b);
  });
});
