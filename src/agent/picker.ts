/**
 * The Brain's monthly pick as a PURE DECISION FUNCTION — the project's primary test seam
 * (PRD → Testing Decisions; issue #5). One Run picks exactly one record.
 *
 * Given the Brain's ranked candidates, the chaos dial, an injected seed, and faked Discogs/
 * Amazon pricing, `pickRecord` deterministically:
 *   1. weights the three Lanes by the chaos dial (seeded) into a candidate order;
 *   2. walks that order, skipping anything already Owned or already Rejected;
 *   3. prices each survivor across sources and buys from the cheaper landed cost
 *      (price is a SOURCE-selector, never a record-selector — CONTEXT.md);
 *   4. if it can't be landed within budget (balance OR per-purchase ceiling), discards it
 *      to the Rejected log and loops to a *different* record;
 *   5. returns a Quote, or "nothing affordable this Run".
 *
 * This slice handles the Gap-fill buy intent only (Splurge arrives with the budget slice).
 * "Roll again" / takebacks are impossible by design: one call, one outcome.
 */
import type {
  BrainAdapter,
  BrainCandidate,
  BrainContext,
  PriceListing,
  PricingAdapter,
} from "@/adapters/types";
import { albumKey, type ChaosDial, type Lane, type RejectReason, type Source } from "@/store/types";

const LANES: Lane[] = ["complete", "adjacent", "stretch"];

export interface PickerInput {
  /** Proposes candidates (Claude in-context in production; faked in tests). */
  brain: BrainAdapter;
  /** Cross-source landed-cost lookup (faked in tests, real Discogs/Amazon in #6). */
  pricing: PricingAdapter;
  /** Taste context: Owned set, Rejected keys, chaos dial — handed to the Brain. */
  taste: BrainContext;
  /** A quote must fit BOTH gates. balance = war chest; ceiling = per-purchase hard max. */
  budget: { balancePence: number; ceilingPence: number };
  /** Injected randomness — fixes lane selection so the function is deterministic in tests. */
  seed: number;
}

/** A landable pick: the chosen record + the cheaper source + its quoted landed cost. */
export interface PickedQuote {
  artist: string;
  title: string;
  lane: Lane;
  why: string;
  source: Source;
  listingUrl: string;
  landedPricePence: number;
  discogsReleaseId?: number;
}

/** A record the Brain wanted but couldn't be landed this Run → the Rejected log. */
export interface RejectedPick {
  artist: string;
  title: string;
  lane: Lane;
  reason: Extract<RejectReason, "over_budget" | "out_of_stock">;
  source?: Source;
  listingUrl?: string;
  quotedPricePence?: number;
}

export type PickResult =
  | { ok: true; quote: PickedQuote; rejected: RejectedPick[] }
  | { ok: false; reason: "nothing_affordable"; rejected: RejectedPick[] };

export async function pickRecord(input: PickerInput): Promise<PickResult> {
  const { brain, pricing, taste, budget, seed } = input;
  const candidates = await brain.propose(taste);

  const ownedKeys = new Set(taste.owned.map((o) => albumKey(o.artist, o.title)));
  const rejectedKeys = new Set(taste.rejectedKeys);
  // A quote can never exceed the balance OR the per-purchase ceiling.
  const affordableCeiling = Math.min(budget.balancePence, budget.ceilingPence);

  const ordered = orderByChaos(candidates, taste.chaosDial, seed);
  const rejected: RejectedPick[] = [];
  const seen = new Set<string>();

  for (const candidate of ordered) {
    const key = albumKey(candidate.artist, candidate.title);
    // Defense in depth: the Brain shouldn't propose owned/rejected/duplicate records, but
    // the picker — not the Brain — is what guarantees it. These are silently skipped, not
    // logged as rejects (they aren't fresh "wanted but couldn't land" outcomes).
    if (ownedKeys.has(key) || rejectedKeys.has(key) || seen.has(key)) continue;
    seen.add(key);

    const listings = await pricing.lookup({ artist: candidate.artist, title: candidate.title });
    const cheapest = cheapestAvailable(listings);
    if (!cheapest) {
      rejected.push(reject(candidate, "out_of_stock"));
      continue;
    }
    if (cheapest.landedPricePence > affordableCeiling) {
      rejected.push(reject(candidate, "over_budget", cheapest));
      continue;
    }

    return {
      ok: true,
      rejected,
      quote: {
        artist: candidate.artist,
        title: candidate.title,
        lane: candidate.lane,
        why: candidate.why,
        source: cheapest.source,
        listingUrl: cheapest.listingUrl,
        landedPricePence: cheapest.landedPricePence,
        discogsReleaseId: cheapest.discogsReleaseId ?? candidate.discogsReleaseId,
      },
    };
  }

  return { ok: false, reason: "nothing_affordable", rejected };
}

/** The cheapest *available* listing by landed cost, or undefined if none are buyable. Shared
 *  with the Splurge picker — price is a source-selector across both buy intents. */
export function cheapestAvailable(listings: PriceListing[]): PriceListing | undefined {
  return listings
    .filter((l) => l.available)
    .reduce<PriceListing | undefined>(
      (best, l) => (best && best.landedPricePence <= l.landedPricePence ? best : l),
      undefined,
    );
}

function reject(
  candidate: BrainCandidate,
  reason: RejectedPick["reason"],
  listing?: PriceListing,
): RejectedPick {
  return {
    artist: candidate.artist,
    title: candidate.title,
    lane: candidate.lane,
    reason,
    source: listing?.source,
    listingUrl: listing?.listingUrl,
    quotedPricePence: listing?.landedPricePence,
  };
}

/**
 * Interleave candidates into a single priority order, weighting each Lane by the chaos dial
 * with a seeded RNG. Best-first order *within* a Lane (the Brain's ranking) is preserved;
 * the chaos dial only decides which Lane to draw from at each step. The full interleaving
 * (not just the head) lets the picker loop across Lanes when its top picks can't be landed.
 */
function orderByChaos(
  candidates: BrainCandidate[],
  chaosDial: ChaosDial,
  seed: number,
): BrainCandidate[] {
  const queues: Record<Lane, BrainCandidate[]> = {
    complete: candidates.filter((c) => c.lane === "complete"),
    adjacent: candidates.filter((c) => c.lane === "adjacent"),
    stretch: candidates.filter((c) => c.lane === "stretch"),
  };

  const rng = mulberry32(seed);
  const ordered: BrainCandidate[] = [];
  let remaining = candidates.length;

  while (remaining > 0) {
    const available = LANES.filter((lane) => queues[lane].length > 0);
    const lane = weightedPick(
      available.map((l) => ({ lane: l, weight: chaosDial[l] })),
      rng,
    );
    ordered.push(queues[lane].shift()!);
    remaining--;
  }
  return ordered;
}

/**
 * Pick a lane proportional to its weight using one draw from `rng`. When every available
 * lane has zero weight (e.g. the chaos-favoured lanes are exhausted), fall back to a uniform
 * choice so candidates are never stranded.
 */
function weightedPick(lanes: { lane: Lane; weight: number }[], rng: () => number): Lane {
  const total = lanes.reduce((sum, l) => sum + Math.max(0, l.weight), 0);
  if (total <= 0) {
    const idx = Math.floor(rng() * lanes.length);
    return lanes[idx]!.lane;
  }
  let r = rng() * total;
  for (const l of lanes) {
    r -= Math.max(0, l.weight);
    if (r < 0) return l.lane;
  }
  return lanes[lanes.length - 1]!.lane;
}

/** Small, fast, fully deterministic PRNG (mulberry32). Same seed → same sequence.
 *  Exported so the Splurge-vs-Gap-fill roll (run.ts) draws from the same seeded family. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
