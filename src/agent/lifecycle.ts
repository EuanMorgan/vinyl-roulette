/**
 * The order lifecycle state machine — the attended half of the two-phase buy (issue #7),
 * driven against the `BuyAdapter` + `PricingAdapter` seams so it runs with fakes (no browser,
 * no network) in tests. Auto-prep (`runGapFill`) parks a PROPOSED Quote; this module moves it
 * the rest of the way:
 *
 *   PROPOSED ──approve──▶ APPROVED ──pay──▶ ORDERED ──arrive──▶ ARRIVED
 *        │
 *        └─ re-validate fails (gone, or > £3 over quote) ──▶ STALE ──re-pick──▶ new PROPOSED
 *
 * Load-bearing rules (CONTEXT.md → Order lifecycle; ADR-0003 — do not re-introduce):
 *   - **Re-validate live at approval, never hold a cart.** The PROPOSED Quote stores a listing
 *     URL + price; at approval we re-check it fresh. Present and within the configured drift
 *     tolerance → proceed; gone or drifted past tolerance → STALE.
 *   - **STALE re-picks, it never silently swaps.** The thing Euan approved is the thing bought,
 *     or he is asked again: the stale order is parked STALE + logged to Rejected, the picker
 *     re-runs, a fresh PROPOSED Quote is written, and Euan is re-notified.
 *   - **A price *drop* is fine** — only upward drift past tolerance is stale; we buy cheaper.
 *
 * This slice swaps in a faked `BuyAdapter`; the real Playwright finalize + Decline arrive in
 * issue #9, and the arrival Reveal + Discogs write-back in issue #10 build on `markArrived`.
 */
import type { BuyAdapter, BuyQuote, PricingAdapter } from "@/adapters/types";
import type { Store } from "@/store/store";
import type { OrderRow, RunTrigger } from "@/store/types";
import { runGapFill, type GapFillDeps, type GapFillOutcome } from "./run";

/** Everything the approval step needs: the picker deps (for a STALE re-pick) plus the Hands. */
export interface ApproveDeps extends GapFillDeps {
  /** Playwright (faked here): re-opens fresh, drives to the payment button, finalizes. */
  buy: BuyAdapter;
}

export type ApproveResult =
  /** Re-validated, paid, recorded: PROPOSED → APPROVED → ORDERED. */
  | { outcome: "ordered"; order: OrderRow }
  /** Listing gone or drifted past tolerance → STALE + a fresh re-pick (or none if Paused/dry). */
  | { outcome: "stale"; staleOrder: OrderRow; reproposed: GapFillOutcome | null }
  /** Drive-to-button or payment failed after approval → FAILED (surfaced to Euan, not re-picked). */
  | { outcome: "failed"; order: OrderRow; error: string }
  /** Guard: the order wasn't PROPOSED (already handled, declined, etc.) — nothing done. */
  | { outcome: "not_proposed"; order: OrderRow | undefined };

/**
 * Approve a PROPOSED order: re-validate the listing live, then either drive payment to ORDERED
 * or mark it STALE and re-pick. Idempotent guard — only a PROPOSED order is actionable.
 *
 * `trigger` tags any STALE re-pick Run (defaults to "manual": approval is a human action).
 */
export async function approveOrder(
  store: Store,
  deps: ApproveDeps,
  orderId: number,
  trigger: RunTrigger = "manual",
): Promise<ApproveResult> {
  const order = store.orders.get(orderId);
  if (!order || order.status !== "PROPOSED") {
    return { outcome: "not_proposed", order };
  }

  // Re-validate the exact listing fresh (ADR-0003): gone or drifted > tolerance ⇒ STALE.
  const tolerance = store.config.get().priceDriftTolerancePence;
  const live = await deps.pricing.revalidate(order.listing_url);
  const gone = live === null || !live.available;
  const driftedOver = live !== null && live.landedPricePence - order.quoted_price_pence > tolerance;

  if (gone || driftedOver) {
    const staleOrder = store.orders.setStatus(orderId, "STALE");
    // Log to Rejected so the re-pick excludes this album and future Runs don't re-suggest it.
    store.rejected.add({
      album_key: order.album_key,
      artist: order.artist,
      title: order.title,
      lane: order.lane,
      reason: "stale",
      source: order.source,
      listing_url: order.listing_url,
      quoted_price_pence: order.quoted_price_pence,
      run_id: order.run_id,
    });
    // Re-pick a *different* record (never a silent swap): runGapFill parks a fresh PROPOSED
    // Quote and re-notifies via the same notifier auto-prep used.
    const reproposed = await runGapFill(store, gapFillDeps(deps), trigger);
    return { outcome: "stale", staleOrder, reproposed };
  }

  // Within tolerance (or cheaper): buy at the re-validated price, which is what Euan approved
  // give-or-take the £3 window — and is what actually appears on the bank statement.
  const finalQuotePrice = live!.landedPricePence;
  store.orders.setStatus(orderId, "APPROVED");

  const quote: BuyQuote = {
    source: order.source,
    listingUrl: order.listing_url,
    expectedPricePence: finalQuotePrice,
  };

  const prep = await deps.buy.prepare(quote);
  if (!prep.ready) {
    return fail(store, orderId, prep.error ?? "could not drive to the payment button");
  }

  const paid = await deps.buy.pay(quote);
  if (!paid.ok) {
    return fail(store, orderId, paid.error ?? "payment did not complete");
  }

  const finalPrice = paid.finalPricePence ?? finalQuotePrice;
  const ordered = store.orders.setStatus(orderId, "ORDERED", { final_price_pence: finalPrice });
  // Money has left: record the spend so the war-chest balance stays honest (the spend-ledger
  // surface + cap accrual are built out in issue #8; this is the spend side of that ledger).
  store.ledger.append({
    entry_type: "order_placed",
    amount_pence: -finalPrice,
    order_id: orderId,
    run_id: order.run_id,
    note: `Ordered from ${order.source}`,
  });
  return { outcome: "ordered", order: ordered };
}

/**
 * Move an ORDERED record to ARRIVED — the transition behind Euan's "[Month]'s record arrived"
 * tap. Thin by design: the Reveal screen + Discogs write-back hang off this in issue #10. Guard
 * keeps the chain honest (only a placed order can arrive).
 */
export function markArrived(store: Store, orderId: number): OrderRow | undefined {
  const order = store.orders.get(orderId);
  if (!order || order.status !== "ORDERED") return order;
  return store.orders.setStatus(orderId, "ARRIVED");
}

function fail(store: Store, orderId: number, error: string): ApproveResult {
  const order = store.orders.setStatus(orderId, "FAILED");
  return { outcome: "failed", order, error };
}

/** Narrow ApproveDeps back to the picker's GapFillDeps for the STALE re-pick. */
function gapFillDeps(deps: ApproveDeps): GapFillDeps {
  return { brain: deps.brain, pricing: deps.pricing, seed: deps.seed, notifier: deps.notifier };
}
