/**
 * The no-auto-cancel surface (issue #12; CONTEXT.md → Kill switch / control surface).
 *
 * Settled rule — DO NOT re-introduce automated cancellation: once an order is **ORDERED**
 * (payment cleared) the app never attempts an auto-cancel/return. A half-successful bot return
 * is worse than none. Since every spend is approved before payment, post-order regret should be
 * rare; when it happens the app's whole contribution is to *surface* the order and a manual
 * cancel link so Euan can cancel himself if he chooses.
 *
 * This module is therefore deliberately inert: a pure, read-only projection of an order into the
 * link Euan would use to cancel by hand. It never transitions the order and never touches the
 * store — the absence of a "cancel" mutation anywhere in the codebase is the feature.
 *
 * Title-hiding holds even here. Before arrival the record is still a surprise (CONTEXT.md →
 * Reveal), so the link is the **account-level** order page, never the specific listing URL —
 * surfacing "how to cancel" must not leak *what* was bought.
 */
import type { OrderRow, Source } from "@/store/types";

/** Amazon UK order history — where a placed order is cancelled/returned by hand. Title-safe. */
export const AMAZON_ORDERS_URL = "https://www.amazon.co.uk/gp/css/order-history";

/** Discogs buyer purchases — where a Marketplace order is managed / the seller is contacted. */
export const DISCOGS_PURCHASES_URL = "https://www.discogs.com/sell/purchases";

const MANAGE_ORDERS_URL: Record<Source, string> = {
  amazon: AMAZON_ORDERS_URL,
  discogs: DISCOGS_PURCHASES_URL,
};

export interface CancelSurface {
  orderId: number;
  source: Source;
  /**
   * The account-level page where Euan cancels the order himself. Deliberately *not* the listing
   * URL: pre-arrival the title is still hidden, so the cancel link must not spoil the record.
   */
  manageOrdersUrl: string;
}

/**
 * Project a placed order into its manual-cancel surface. Pure and read-only — the app offers a
 * link, never an action (it will not cancel the order for Euan). Caller decides whether to show
 * it (a regret affordance); this just computes the title-safe destination.
 */
export function cancelSurfaceFor(order: OrderRow): CancelSurface {
  return {
    orderId: order.id,
    source: order.source,
    manageOrdersUrl: MANAGE_ORDERS_URL[order.source],
  };
}
