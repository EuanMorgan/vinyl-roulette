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

import type { Lane, Source } from "@/store/types";

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
 * The Hands: Playwright driving Euan's real Chrome profile (ADR-0003). Split to honour
 * the two-phase buy — `prepare` runs unattended up to the payment button; `pay` runs
 * attended after Euan approves and clears any 2FA.
 */
export interface BuyAdapter {
  /** Unattended: drive to the payment button for this quote. */
  prepare(quote: BuyQuote): Promise<{ ready: boolean; error?: string }>;
  /** Attended: finalize payment (Euan has cleared 2FA). */
  pay(quote: BuyQuote): Promise<BuyResult>;
}

/** A pick the Brain decided on, before sourcing/pricing — for documentation/typing. */
export interface PickIntent {
  artist: string;
  title: string;
  lane: Lane;
}
