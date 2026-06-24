/**
 * Row and enum types mirroring the schema in `migrations.ts`. These are the shared
 * vocabulary both clients (agent + UI) program against.
 */

export type Lane = "complete" | "adjacent" | "stretch";
export type Source = "discogs" | "amazon";
export type BuyIntent = "gap_fill" | "splurge";
export type OrderStatus =
  | "PROPOSED"
  | "APPROVED"
  | "ORDERED"
  | "ARRIVED"
  | "STALE"
  | "FAILED"
  | "DECLINED";
export type RejectReason = "over_budget" | "out_of_stock" | "declined" | "stale";
export type RunTrigger = "scheduled" | "manual";
export type RunStatus = "started" | "finished" | "failed";
export type LedgerEntryType = "cap_added" | "order_placed" | "refund" | "adjustment";

export interface RunRow {
  id: number;
  trigger: RunTrigger;
  status: RunStatus;
  summary: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface CollectionRow {
  id: number;
  album_key: string;
  artist: string;
  title: string;
  year: number | null;
  discogs_release_id: number | null;
  discogs_instance_id: number | null;
  genres: string | null;
  styles: string | null;
  date_added: string | null;
  synced_at: string;
}

export interface RatingRow {
  album_key: string;
  artist: string;
  title: string;
  rating: number;
  created_at: string;
  updated_at: string;
}

export interface NoteRow {
  id: number;
  album_key: string;
  artist: string;
  title: string;
  body: string;
  created_at: string;
}

export interface RejectedRow {
  id: number;
  album_key: string;
  artist: string;
  title: string;
  lane: Lane | null;
  reason: RejectReason;
  source: Source | null;
  listing_url: string | null;
  quoted_price_pence: number | null;
  run_id: number | null;
  created_at: string;
}

export interface OrderRow {
  id: number;
  run_id: number | null;
  album_key: string;
  artist: string;
  title: string;
  lane: Lane | null;
  intent: BuyIntent;
  why: string | null;
  source: Source;
  listing_url: string;
  quoted_price_pence: number;
  final_price_pence: number | null;
  discogs_release_id: number | null;
  status: OrderStatus;
  created_at: string;
  approved_at: string | null;
  ordered_at: string | null;
  arrived_at: string | null;
  updated_at: string;
}

export interface LedgerRow {
  id: number;
  run_id: number | null;
  order_id: number | null;
  entry_type: LedgerEntryType;
  amount_pence: number;
  balance_after_pence: number;
  note: string | null;
  created_at: string;
}

/** Typed view of the key/value config table. */
export interface Config {
  monthlyCapPence: number;
  perPurchaseCeilingPence: number;
  /** Lane weights for the chaos dial; need not sum to 1, the picker normalizes. */
  chaosDial: { complete: number; adjacent: number; stretch: number };
  priceDriftTolerancePence: number;
  paused: boolean;
}

export const DEFAULT_CONFIG: Config = {
  monthlyCapPence: 3000, // £30
  perPurchaseCeilingPence: 6000, // £60
  chaosDial: { complete: 0.5, adjacent: 0.35, stretch: 0.15 },
  priceDriftTolerancePence: 300, // £3 (ADR-0003)
  paused: false,
};

/**
 * The picker-facing taste signal: one owned album annotated with its rating and notes.
 * `rating` is null when the album is owned but unrated — under "ownership is not
 * endorsement" that is the *absence* of a positive signal, never a neutral/low one, so
 * the picker can tell loved (high rating) from tolerated (low) from no-signal (null).
 * `genres`/`styles` are parsed (the raw store rows keep them JSON-encoded).
 */
export interface TasteRow {
  album_key: string;
  artist: string;
  title: string;
  year: number | null;
  genres: string[];
  styles: string[];
  rating: number | null;
  notes: string[];
}

/** Parse a JSON-encoded string array (genres/styles), tolerating null/garbage. */
export function parseTags(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

/** Normalize artist + title into the album-level dupe-avoidance key. */
export function albumKey(artist: string, title: string): string {
  const norm = (s: string) =>
    s
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "") // strip diacritics
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  return `${norm(artist)}|${norm(title)}`;
}
