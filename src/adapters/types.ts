/**
 * Adapter interfaces — the project's seam convention (PRD → Testing Decisions).
 *
 * Every external dependency the agent reaches for sits behind a *thin* interface
 * defined here. Production code depends on the interface, never the implementation;
 * tests inject a fake at this same boundary (see `fakes.ts`) so the picker and the
 * order lifecycle can be exercised with no network and no browser.
 *
 * Keep these interfaces narrow: the boundary is "what the Brain needs", not "everything
 * the API can do". Faking a fat interface is painful; that pain is the design feedback.
 *
 * NOTE: these are the *contracts only*. Real Discogs/price/Playwright implementations
 * land in their own later slices; this slice only establishes the shape + faking pattern.
 */

import type { ChaosDial, Lane, Source } from "@/store/types";

/** One owned record as returned by a Discogs collection sync. */
export interface DiscogsCollectionItem {
  artist: string;
  title: string;
  year?: number;
  discogsReleaseId?: number;
  discogsInstanceId?: number;
  genres?: string[];
  styles?: string[];
  dateAdded?: string;
}

/** Reads Euan's Discogs library (and, later, resolves release metadata). */
export interface DiscogsAdapter {
  /** Fetch the full owned collection for the read-sync. */
  fetchCollection(): Promise<DiscogsCollectionItem[]>;
}

/** A concrete buyable listing on one source, priced on landed cost (item + shipping). */
export interface PriceListing {
  source: Source;
  listingUrl: string;
  /** Landed cost in pence (item + shipping to Euan, GBP). */
  landedPricePence: number;
  available: boolean;
  discogsReleaseId?: number;
  /**
   * Shipping component of the landed cost, in pence (GBP), when the source breaks it out.
   * Captured for transparency (the ledger/Reveal can show item + shipping); the picker only
   * compares `landedPricePence`. Discogs reports per-seller shipping; Amazon is usually
   * Prime/free (0) so this stays absent or 0.
   */
  shippingPence?: number;
  /**
   * Condition grade where the source provides one (Discogs Marketplace is condition-graded,
   * e.g. "Near Mint (NM or M-)"). Amazon new repressings have none. Captured per the #6
   * acceptance criterion ("availability/condition data captured where the source provides it").
   */
  condition?: string;
}

/**
 * Cross-source price/availability lookup. Price is a *source-selector*: given a chosen
 * record, return the available listings so the caller buys from the cheaper landed cost.
 */
export interface PricingAdapter {
  /** Listings for a specific album across Discogs Marketplace and Amazon. */
  lookup(query: { artist: string; title: string }): Promise<PriceListing[]>;
  /** Re-validate a single listing live at approval time (ADR-0003 staleness check). */
  revalidate(listingUrl: string): Promise<PriceListing | null>;
}

/** The quote auto-prep drives Playwright up to the payment button against. */
export interface BuyQuote {
  source: Source;
  listingUrl: string;
  expectedPricePence: number;
}

export interface BuyResult {
  ok: boolean;
  /** Actual landed price charged, in pence (present when ok). */
  finalPricePence?: number;
  /** Order/confirmation reference from the source, if any. */
  reference?: string;
  /** Why it failed, for the FAILED transition + ledger note. */
  error?: string;
}

/**
 * The Hands: Playwright driving Euan's real Chrome profile (ADR-0003). Both calls run at
 * APPROVAL time, fresh — auto-prep holds *no* live cart (it stores a Quote; CONTEXT.md →
 * Order lifecycle), so the browser is only ever driven once Euan has approved the spend.
 * `prepare` re-opens the re-validated listing and drives to the payment button; Euan then
 * clears any 2FA / PayPal / CVV challenge a bot can't; `pay` finalizes. The split exists so
 * the human-in-the-loop step (#9) sits cleanly between drive-to-button and finalize.
 */
export interface BuyAdapter {
  /** Re-open the listing fresh and drive to the payment button for this quote. */
  prepare(quote: BuyQuote): Promise<{ ready: boolean; error?: string }>;
  /** Finalize payment (Euan has cleared any 2FA challenge). */
  pay(quote: BuyQuote): Promise<BuyResult>;
}

/** What auto-prep tells the human when an order reaches PROPOSED — price + source only. */
export interface ProposedNotification {
  orderId: number;
  source: Source;
  /** Quoted landed cost in pence (GBP). */
  pricePence: number;
}

/**
 * The notify seam: a local desktop notification raised when auto-prep parks a PROPOSED
 * order ("a record is on its way — approve £X at <source>"). It must work from a *headless*
 * scheduled Run (ADR-0001), and is **title-hiding by design** — the payload carries price +
 * source only, never the record title, so the surprise survives until the arrival Reveal
 * (CONTEXT.md → Two-phase buy). Tests inject `FakeNotificationAdapter` at this boundary.
 */
export interface NotificationAdapter {
  proposed(notification: ProposedNotification): Promise<void>;
}

/** A pick the Brain decided on, before sourcing/pricing — for documentation/typing. */
export interface PickIntent {
  artist: string;
  title: string;
  lane: Lane;
}

/** One owned album as taste evidence for the Brain (genres + the learning signal). */
export interface OwnedAlbumContext {
  artist: string;
  title: string;
  genres?: string[];
  styles?: string[];
  /** User rating, if any — distinguishes loved from merely tolerated (ownership ≠ endorsement). */
  rating?: number;
  /** Free-text notes the user left on this album. */
  notes?: string[];
}

/** Everything the Brain reasons over to propose candidates for one Run. */
export interface BrainContext {
  /** The Owned set as taste evidence (collection ∪ purchase ledger). */
  owned: OwnedAlbumContext[];
  /** Album keys already in the Rejected log — don't re-suggest these (CONTEXT.md). */
  rejectedKeys: string[];
  /** Lane weights for this Run; the Brain may bias its proposals, the picker weights selection. */
  chaosDial: ChaosDial;
}

/** A record the Brain wants, tagged with its Lane and the rationale for the Reveal. */
export interface BrainCandidate {
  artist: string;
  title: string;
  lane: Lane;
  /** One-line rationale ("why it was picked"), surfaced on the Reveal screen. */
  why: string;
  discogsReleaseId?: number;
}

/**
 * The Brain seam: proposes ranked candidate picks across the three Lanes. The *real*
 * implementation is Claude reasoning in-context each Run (ADR-0001) — there is no trained
 * recommender or gap-detection algorithm. This slice (#5) consumes a fake at this boundary
 * so the picker is a deterministic pure function; the real Brain lands in a later slice.
 *
 * Candidates are returned best-first *within* each Lane; the picker applies the chaos-dial
 * weighting + seed to decide which Lane (and thus which candidate) actually wins.
 */
export interface BrainAdapter {
  propose(ctx: BrainContext): Promise<BrainCandidate[]>;
}
