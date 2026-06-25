/**
 * The arrival Reveal + Discogs write-back (issue #10) — the payoff the whole product withholds
 * for. When a package physically arrives, Euan taps "[Month]'s record arrived": the order moves
 * ARRIVED (the `markArrived` transition in lifecycle.ts), and *that tap* is the first time the
 * title is shown and the record is logged to Discogs (CONTEXT.md → "It's here" / Reveal).
 *
 * This module builds the Reveal payload (what / why / how-it-fits) and performs the write-back:
 *   - **Discogs-sourced buy** → the exact release id was captured on the order at prep time, so
 *     logging is a one-tap auto-add (`discogs.kind: "ready"`).
 *   - **Amazon-sourced buy** → no Discogs release id was known, so the Reveal pre-fills a
 *     best-guess shortlist for Euan to confirm/correct in one tap (`discogs.kind: "needs_match"`).
 * Once logged the order carries the returned instance id, so a re-tap is a no-op (`"logged"`).
 *
 * Load-bearing rule (CONTEXT.md → Reveal; do not re-introduce): the record is logged to Discogs
 * on the arrival tap, *never* at order time — so write-back only ever fires on an ARRIVED order.
 */
import type { DiscogsAdapter, DiscogsReleaseMatch } from "@/adapters/types";
import type { Store } from "@/store/store";
import type { BuyIntent, Lane, OrderRow, Source } from "@/store/types";

/** The Discogs write-back state the Reveal renders its one-tap control from. */
export type RevealDiscogsState =
  /** Already logged: the record is in Euan's Discogs collection (instance id recorded). */
  | { kind: "logged"; releaseId: number | null; instanceId: number; loggedAt: string | null }
  /** Discogs-sourced buy: the release id is known → one tap auto-adds it. */
  | { kind: "ready"; releaseId: number }
  /** Amazon-sourced buy: no release id known → confirm/correct one of these best guesses. */
  | { kind: "needs_match"; suggestions: DiscogsReleaseMatch[] };

/** Everything the Reveal screen shows once a record has arrived — the title is no longer hidden. */
export interface RevealView {
  orderId: number;
  /** Album identity for the rating/note controls (feedback applies to the whole Collection). */
  albumKey: string;
  artist: string;
  title: string;
  /** How it fits: which Lane the pick filled (Complete / Adjacent / Stretch). */
  lane: Lane | null;
  intent: BuyIntent;
  /** Why it was picked — the one-line rationale captured at prep time. */
  why: string | null;
  source: Source;
  /** What was actually paid (falls back to the quote if a final price was never recorded). */
  pricePence: number;
  arrivedAt: string | null;
  discogs: RevealDiscogsState;
  /** Current rating for the album, or null (no-signal — never coerced to a low score). */
  rating: number | null;
  notes: string[];
}

/** Optional deps for `buildReveal`: a Discogs adapter to pre-fill best-guess matches. */
export interface RevealDeps {
  discogs?: DiscogsAdapter;
}

/**
 * Build the Reveal payload for an order. Intended for an ARRIVED order (the title is shown), but
 * left to the caller to choose which orders to reveal. For an Amazon buy not yet logged, searches
 * Discogs for best-guess matches; a search failure degrades to an empty shortlist (Euan can still
 * enter a release id by hand) rather than breaking the Reveal.
 */
export async function buildReveal(
  store: Store,
  order: OrderRow,
  deps: RevealDeps = {},
): Promise<RevealView> {
  const rating = store.ratings.get(order.album_key)?.rating ?? null;
  const notes = store.notes.listFor(order.album_key).map((n) => n.body);
  return {
    orderId: order.id,
    albumKey: order.album_key,
    artist: order.artist,
    title: order.title,
    lane: order.lane,
    intent: order.intent,
    why: order.why,
    source: order.source,
    pricePence: order.final_price_pence ?? order.quoted_price_pence,
    arrivedAt: order.arrived_at,
    discogs: await buildDiscogsState(order, deps),
    rating,
    notes,
  };
}

async function buildDiscogsState(order: OrderRow, deps: RevealDeps): Promise<RevealDiscogsState> {
  if (order.discogs_instance_id !== null) {
    return {
      kind: "logged",
      releaseId: order.discogs_release_id,
      instanceId: order.discogs_instance_id,
      loggedAt: order.discogs_logged_at,
    };
  }
  if (order.discogs_release_id !== null) {
    return { kind: "ready", releaseId: order.discogs_release_id };
  }
  const suggestions = deps.discogs ? await searchSafe(deps.discogs, order) : [];
  return { kind: "needs_match", suggestions };
}

/** Best-guess matches for an order, swallowing any search error into an empty shortlist. */
async function searchSafe(discogs: DiscogsAdapter, order: OrderRow): Promise<DiscogsReleaseMatch[]> {
  try {
    return await discogs.searchReleases({ artist: order.artist, title: order.title });
  } catch (err) {
    console.warn("[reveal] Discogs release search failed:", err);
    return [];
  }
}

export type LogArrivalResult =
  /** Added to the Discogs collection; the order now carries the release + instance id. */
  | { outcome: "logged"; order: OrderRow }
  /** Already in the collection (idempotent re-tap) — nothing added. */
  | { outcome: "already_logged"; order: OrderRow }
  /** Guard: only an ARRIVED order is logged (title-on-arrival rule) — nothing done. */
  | { outcome: "not_arrived"; order: OrderRow | undefined }
  /** No release id to add (Amazon buy not yet confirmed) — the UI must supply one. */
  | { outcome: "no_release"; order: OrderRow }
  /** The Discogs write failed; the order stays un-logged so the tap can be retried. */
  | { outcome: "failed"; order: OrderRow; error: string };

/**
 * Log an arrived record to Euan's Discogs collection — the write-back behind the Reveal's
 * one-tap add. `releaseId` confirms/corrects the release for an Amazon buy (whose release id was
 * unknown at order time); omit it for a Discogs buy to use the id captured on the order.
 *
 * Idempotent: a record already logged (instance id recorded) is a no-op, so a double-tap never
 * adds a second copy. Only an ARRIVED order is loggable — the record is logged on the arrival
 * tap, never before (CONTEXT.md → Reveal).
 */
export async function logArrivalToDiscogs(
  store: Store,
  deps: { discogs: DiscogsAdapter },
  orderId: number,
  releaseId?: number,
): Promise<LogArrivalResult> {
  const order = store.orders.get(orderId);
  if (!order || order.status !== "ARRIVED") return { outcome: "not_arrived", order };
  if (order.discogs_instance_id !== null) return { outcome: "already_logged", order };

  const release = releaseId ?? order.discogs_release_id ?? undefined;
  if (release === undefined || !Number.isInteger(release) || release <= 0) {
    return { outcome: "no_release", order };
  }

  try {
    const { instanceId } = await deps.discogs.addToCollection(release);
    const updated = store.orders.recordDiscogsLog(orderId, release, instanceId);
    return { outcome: "logged", order: updated };
  } catch (err) {
    return { outcome: "failed", order, error: err instanceof Error ? err.message : String(err) };
  }
}
