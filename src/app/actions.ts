"use server";

import { revalidatePath } from "next/cache";
import { getStore } from "@/lib/store-instance";
import { approveOrder, declineOrder, type ApproveDeps } from "@/agent/lifecycle";
import { buyAdapterFromEnv } from "@/adapters/buy";
import { pricingAdapterFromEnv } from "@/adapters/pricing";
import { notificationAdapterFromEnv } from "@/adapters/notify";
import type { BrainAdapter } from "@/adapters/types";

/**
 * Server actions are the UI's only writes to the spine. They are deliberately thin —
 * validate the form payload, delegate to the typed store (where the logic and tests
 * live, ADR-0002), then revalidate the page so the new rating/note shows on next render.
 * No API sits between the UI and the file; these run server-side against the SQLite store.
 */

/** Parse a positive integer order id from a form payload, or null if it's missing/garbage. */
function orderIdFrom(formData: FormData): number | null {
  const raw = formData.get("order_id");
  const id = Number(raw);
  return raw && Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * The real Brain (Claude reasoning in-context) is a later slice; until it lands, a STALE re-pick
 * at approval has nothing to propose. This no-op Brain keeps the dependency honest — a stale
 * order is still parked STALE and logged to Rejected, it just can't be re-proposed immediately.
 */
const noopBrain: BrainAdapter = { async propose() { return []; } };

/**
 * Assemble the approval-time dependencies from env: real cross-source pricing for the live
 * re-validation, the real Playwright buy adapter driving Euan's Chrome profile, and the desktop
 * notifier for any STALE re-pick. Returns null when no real Chrome profile is configured
 * (CHROME_USER_DATA_DIR unset) — without it there is nothing to drive the payment with.
 */
function approveDeps(): ApproveDeps | null {
  const buy = buyAdapterFromEnv();
  if (!buy) return null;
  return {
    brain: noopBrain,
    pricing: pricingAdapterFromEnv(),
    buy,
    seed: Date.now(),
    notifier: notificationAdapterFromEnv(),
  };
}

/**
 * Approve a PROPOSED order (issue #9): re-validate the listing live, then drive the real
 * Playwright buy through to ORDERED (Euan clears any 2FA/PayPal/CVV in the headed browser). The
 * order's title is never surfaced — Euan authorises the spend, not the record. A no-op if the
 * order isn't PROPOSED (handled by `approveOrder`) or no Chrome profile is configured to buy with.
 */
export async function approveOrderAction(formData: FormData): Promise<void> {
  const orderId = orderIdFrom(formData);
  if (orderId === null) return;
  const deps = approveDeps();
  if (!deps) {
    console.warn(
      "[ui] approve ignored: set CHROME_USER_DATA_DIR to your real Chrome profile to drive the buy.",
    );
    return;
  }
  await approveOrder(getStore(), deps, orderId, "manual");
  revalidatePath("/");
}

/**
 * Decline a PROPOSED order (issue #9): the human veto. No money moves and the record goes to the
 * Rejected log so it isn't re-suggested. Synchronous — declining never touches the browser.
 */
export async function declineOrderAction(formData: FormData): Promise<void> {
  const orderId = orderIdFrom(formData);
  if (orderId === null) return;
  declineOrder(getStore(), orderId);
  revalidatePath("/");
}

/** Set (or change) the album-level rating for any collection record. */
export async function setRatingAction(formData: FormData): Promise<void> {
  const albumKey = String(formData.get("album_key") ?? "");
  const artist = String(formData.get("artist") ?? "");
  const title = String(formData.get("title") ?? "");
  const rating = Number(formData.get("rating"));
  if (!albumKey || !Number.isInteger(rating) || rating < 1 || rating > 5) return;
  getStore().ratings.set(albumKey, artist, title, rating);
  revalidatePath("/");
}

/** Clear a rating, returning the album to no-signal (null) — not a low score. */
export async function clearRatingAction(formData: FormData): Promise<void> {
  const albumKey = String(formData.get("album_key") ?? "");
  if (!albumKey) return;
  getStore().ratings.clear(albumKey);
  revalidatePath("/");
}

/** Append a free-text note (preserved verbatim) to any collection record. */
export async function addNoteAction(formData: FormData): Promise<void> {
  const albumKey = String(formData.get("album_key") ?? "");
  const artist = String(formData.get("artist") ?? "");
  const title = String(formData.get("title") ?? "");
  const body = String(formData.get("body") ?? "").trim();
  if (!albumKey || !body) return;
  getStore().notes.add(albumKey, artist, title, body);
  revalidatePath("/");
}
