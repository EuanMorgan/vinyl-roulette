"use server";

import { spawn } from "node:child_process";
import { revalidatePath } from "next/cache";
import { getStore } from "@/lib/store-instance";
import { approveOrder, declineOrder, markArrived, type ApproveDeps } from "@/agent/lifecycle";
import { logArrivalToDiscogs } from "@/agent/reveal";
import { agentInvocation } from "@/agent/launch";
import { buyAdapterFromEnv } from "@/adapters/buy";
import { pricingAdapterFromEnv } from "@/adapters/pricing";
import { notificationAdapterFromEnv } from "@/adapters/notify";
import { discogsAdapterFromEnv } from "@/adapters/discogs";
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

/**
 * The arrival tap (issue #10): move an ORDERED record to ARRIVED — the Reveal moment. This is
 * the first point the title is shown and the record becomes loggable to Discogs; `markArrived`
 * guards that only a placed order can arrive. The Discogs write-back is a *separate* one-tap step
 * (`logArrivalAction`) so an Amazon buy can confirm its best-guess release first.
 */
export async function markArrivedAction(formData: FormData): Promise<void> {
  const orderId = orderIdFrom(formData);
  if (orderId === null) return;
  // markArrived guards that only an ORDERED record can arrive; revalidate only on a real
  // transition so a stale double-tap (already ARRIVED, or never ORDERED) doesn't churn the page.
  const order = markArrived(getStore(), orderId);
  if (order?.status === "ARRIVED") revalidatePath("/");
}

/** Parse a positive-integer release id from a form payload, or undefined if absent/garbage. */
function releaseIdFrom(formData: FormData): number | undefined {
  const raw = formData.get("release_id");
  const id = Number(raw);
  return raw && Number.isInteger(id) && id > 0 ? id : undefined;
}

/**
 * Log an arrived record to Euan's Discogs collection (issue #10). A Discogs-sourced buy logs in
 * one tap (the release id rode along on the order); an Amazon-sourced buy passes the release id
 * Euan confirmed/corrected from the best-guess shortlist. Idempotent and ARRIVED-only — both
 * enforced by `logArrivalToDiscogs`. A no-op if no Discogs credentials are configured.
 */
export async function logArrivalAction(formData: FormData): Promise<void> {
  const orderId = orderIdFrom(formData);
  if (orderId === null) return;
  const discogs = discogsAdapterFromEnv();
  if (!discogs) {
    console.warn(
      "[ui] arrival log ignored: set DISCOGS_USERNAME + DISCOGS_TOKEN to write back to Discogs.",
    );
    return;
  }
  await logArrivalToDiscogs(getStore(), { discogs }, orderId, releaseIdFrom(formData));
  revalidatePath("/");
}

/**
 * "Run now" (issue #11): fire the agent entrypoint on demand — the same command the Windows Task
 * Scheduler job runs, the only difference being `manual` trigger and no `--if-due` catch-up gate
 * (an explicit tap always runs). Spawned detached so the Run is decoupled from the UI: it writes
 * its results straight to the SQLite spine and outlives this request, exactly as the scheduled Run
 * does with the UI closed. We don't await it — the new Run row shows up on the next page load.
 */
export async function runNowAction(): Promise<void> {
  const { command, args } = agentInvocation("manual");
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      // npm is a `.cmd` shim on Windows, which Node can only launch through a shell.
      shell: process.platform === "win32",
    });
    child.on("error", (err) => console.warn("[ui] Run now failed to spawn the agent:", err));
    child.unref();
  } catch (err) {
    // A failed spawn must not 500 the page — surface it in the log and let Euan retry.
    console.warn("[ui] Run now could not start the agent:", err);
  }
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
