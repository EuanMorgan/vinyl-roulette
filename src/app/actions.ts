"use server";

import { revalidatePath } from "next/cache";
import { getStore } from "@/lib/store-instance";

/**
 * Server actions are the UI's only writes to the spine. They are deliberately thin —
 * validate the form payload, delegate to the typed store (where the logic and tests
 * live, ADR-0002), then revalidate the page so the new rating/note shows on next render.
 * No API sits between the UI and the file; these run server-side against the SQLite store.
 */

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
