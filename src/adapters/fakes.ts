/**
 * In-memory fakes for the adapter seam. This is the documented faking pattern (PRD →
 * Testing Decisions): tests construct a fake with canned data, inject it where the real
 * adapter would go, and assert on behaviour at the seam — never on network or a browser.
 *
 * Fakes are *configurable data holders*, not mocks: you set up their world up front
 * (a collection, a price table, "this listing is now gone") and read back what happened.
 */

import type {
  BrainAdapter,
  BrainCandidate,
  BrainContext,
  BuyAdapter,
  BuyQuote,
  BuyResult,
  DiscogsAdapter,
  DiscogsCollectionItem,
  DiscogsReleaseMatch,
  NotificationAdapter,
  PriceListing,
  PricingAdapter,
  ProposedNotification,
} from "./types";

export class FakeDiscogsAdapter implements DiscogsAdapter {
  constructor(private items: DiscogsCollectionItem[] = []) {}
  /** Search results keyed by `${artist}::${title}` (case-insensitive). */
  private searchTable = new Map<string, DiscogsReleaseMatch[]>();
  /** Release ids that `addToCollection` should reject (simulate a write failure), by id. */
  private addFailures = new Set<number>();
  /** Every release id added to the collection, in order — for assertions. */
  readonly added: number[] = [];
  /** Next instance id `addToCollection` will hand back (auto-increments per add). */
  private nextInstanceId = 9000;

  private key(artist: string, title: string): string {
    return `${artist}::${title}`.toLowerCase();
  }

  setCollection(items: DiscogsCollectionItem[]): void {
    this.items = items;
  }
  setSearchResults(artist: string, title: string, matches: DiscogsReleaseMatch[]): void {
    this.searchTable.set(this.key(artist, title), matches);
  }
  failAdd(releaseId: number): void {
    this.addFailures.add(releaseId);
  }

  async fetchCollection(): Promise<DiscogsCollectionItem[]> {
    return this.items;
  }
  async searchReleases(query: { artist: string; title: string }): Promise<DiscogsReleaseMatch[]> {
    return this.searchTable.get(this.key(query.artist, query.title)) ?? [];
  }
  async addToCollection(releaseId: number): Promise<{ instanceId: number }> {
    if (this.addFailures.has(releaseId)) {
      throw new Error(`fake Discogs: refusing to add release ${releaseId}`);
    }
    this.added.push(releaseId);
    return { instanceId: this.nextInstanceId++ };
  }
}

/**
 * Stands in for Claude's in-context reasoning: returns a canned, ordered candidate list
 * and records the context it was asked with so tests can assert what the Brain saw.
 */
export class FakeBrainAdapter implements BrainAdapter {
  constructor(private candidates: BrainCandidate[] = []) {}
  /** The context of the most recent `propose` call (for assertions). */
  lastContext?: BrainContext;
  setCandidates(candidates: BrainCandidate[]): void {
    this.candidates = candidates;
  }
  async propose(ctx: BrainContext): Promise<BrainCandidate[]> {
    this.lastContext = ctx;
    return this.candidates;
  }
}

/** Keyed by `${artist}::${title}` (case-insensitive); set listings per album. */
export class FakePricingAdapter implements PricingAdapter {
  private table = new Map<string, PriceListing[]>();
  /** Listings the `revalidate` call should treat as gone, by URL. */
  private gone = new Set<string>();
  /** Override a listing's revalidated price, by URL (simulates price drift). */
  private drifted = new Map<string, number>();

  private key(artist: string, title: string): string {
    return `${artist}::${title}`.toLowerCase();
  }

  setListings(artist: string, title: string, listings: PriceListing[]): void {
    this.table.set(this.key(artist, title), listings);
  }
  markGone(listingUrl: string): void {
    this.gone.add(listingUrl);
  }
  setDriftedPrice(listingUrl: string, landedPricePence: number): void {
    this.drifted.set(listingUrl, landedPricePence);
  }

  async lookup(query: { artist: string; title: string }): Promise<PriceListing[]> {
    return this.table.get(this.key(query.artist, query.title)) ?? [];
  }

  async revalidate(listingUrl: string): Promise<PriceListing | null> {
    if (this.gone.has(listingUrl)) return null;
    for (const listings of this.table.values()) {
      const found = listings.find((l) => l.listingUrl === listingUrl);
      if (found) {
        const drift = this.drifted.get(listingUrl);
        return drift === undefined ? found : { ...found, landedPricePence: drift };
      }
    }
    return null;
  }
}

/** Records every prepare/pay call so tests can assert the lifecycle drove the Hands. */
export class FakeBuyAdapter implements BuyAdapter {
  readonly prepared: BuyQuote[] = [];
  readonly paid: BuyQuote[] = [];
  /** Set to make `prepare` report not-ready. */
  prepareError?: string;
  /** Set to make `pay` fail. */
  payError?: string;

  async prepare(quote: BuyQuote): Promise<{ ready: boolean; error?: string }> {
    this.prepared.push(quote);
    if (this.prepareError) return { ready: false, error: this.prepareError };
    return { ready: true };
  }

  async pay(quote: BuyQuote): Promise<BuyResult> {
    this.paid.push(quote);
    if (this.payError) return { ok: false, error: this.payError };
    return { ok: true, finalPricePence: quote.expectedPricePence, reference: "FAKE-REF" };
  }
}

/** Records every PROPOSED notification so tests can assert price + source were surfaced. */
export class FakeNotificationAdapter implements NotificationAdapter {
  readonly sent: ProposedNotification[] = [];

  async proposed(notification: ProposedNotification): Promise<void> {
    this.sent.push(notification);
  }
}
