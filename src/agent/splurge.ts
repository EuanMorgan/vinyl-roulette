/**
 * The Splurge pick as a PURE DECISION FUNCTION (issue #8) — the occasional, war-chest-funded
 * second buy intent (CONTEXT.md → Buy intent). Where Gap-fill draws a *new* record from the
 * Brain, a Splurge raids the **Rejected log** (its dual role as the Splurge wishlist): it takes
 * the pricey records once wanted-but-unaffordable, priciest-first, and clears the first one the
 * grown war chest can now land under the per-purchase ceiling.
 *
 * Like `pickRecord`, price is a *source-selector*: the record is chosen first, then bought from
 * the cheaper landed cost. The wishlist's stored quote is only the affordability hint that put
 * it in front of the Splurge — the price that gates the buy is the *live* re-priced one, so a
 * record that drifted out of reach (or sold out) is skipped, never overspent.
 */
import type { PricingAdapter } from "@/adapters/types";
import type { Lane, Source } from "@/store/types";
import { cheapestAvailable } from "./picker";

/** One Splurge target: a Rejected-log album + the highest price it was once quoted at. */
export interface SplurgeCandidate {
  album_key: string;
  artist: string;
  title: string;
  /** The Lane it was originally rejected from, if known — carried to the Reveal. */
  lane?: Lane | null;
  /** The stored quote — an affordability *hint* for ordering; the live re-price gates the buy. */
  quotedPricePence: number;
}

export interface SplurgeInput {
  /** Cross-source landed-cost lookup (faked in tests, real Discogs/Amazon in #6). */
  pricing: PricingAdapter;
  /** Wishlist targets, priciest-first (the store's `rejected.splurgeWishlist()`). */
  candidates: SplurgeCandidate[];
  /** The Owned set — a Splurge must never re-buy an album already owned. */
  ownedKeys: Set<string>;
  /** A Splurge must fit BOTH gates: balance = war chest; ceiling = per-purchase hard max. */
  budget: { balancePence: number; ceilingPence: number };
}

/** A landable Splurge: the cleared record + the cheaper source + its live landed cost. */
export interface SplurgePicked {
  album_key: string;
  artist: string;
  title: string;
  lane?: Lane | null;
  source: Source;
  listingUrl: string;
  landedPricePence: number;
  discogsReleaseId?: number;
}

export type SplurgeResult =
  | { ok: true; quote: SplurgePicked }
  | { ok: false; reason: "nothing_affordable" };

export async function pickSplurge(input: SplurgeInput): Promise<SplurgeResult> {
  const { pricing, candidates, ownedKeys, budget } = input;
  // A Splurge can never exceed the balance OR the per-purchase ceiling (CONTEXT.md → Budget).
  const affordableCeiling = Math.min(budget.balancePence, budget.ceilingPence);

  for (const candidate of candidates) {
    if (ownedKeys.has(candidate.album_key)) continue; // never re-buy an owned album

    const listings = await pricing.lookup({ artist: candidate.artist, title: candidate.title });
    const cheapest = cheapestAvailable(listings);
    if (!cheapest) continue; // sold out since it was rejected — leave it on the wishlist
    if (cheapest.landedPricePence > affordableCeiling) continue; // still out of reach this Run

    return {
      ok: true,
      quote: {
        album_key: candidate.album_key,
        artist: candidate.artist,
        title: candidate.title,
        lane: candidate.lane ?? null,
        source: cheapest.source,
        listingUrl: cheapest.listingUrl,
        landedPricePence: cheapest.landedPricePence,
        discogsReleaseId: cheapest.discogsReleaseId,
      },
    };
  }

  return { ok: false, reason: "nothing_affordable" };
}
