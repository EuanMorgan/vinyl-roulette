/**
 * The agent entrypoint (ADR-0001). In production this is what the scheduled `claude -p`
 * invocation drives each month; the "Run now" UI button shells out to the same script.
 *
 * `runGapFill` is the Run body for the default Gap-fill buy intent (issue #5): it assembles
 * the taste context + budget from the SQLite spine, calls the pure `pickRecord`, writes any
 * "wanted but couldn't land" records to the Rejected log, and parks the winner as a PROPOSED
 * Quote (a quote, not a held cart — ADR-0003). It is pure-ish: all music/network reasoning
 * is behind the injected Brain + pricing adapters, so it's exercised with fakes in tests.
 *
 * Real cross-source pricing (#6) now ships as `HttpPricingAdapter` (`pricingAdapterFromEnv`);
 * the real Brain (Claude in-context) is still a separate slice. Until the Brain lands, `main()`
 * runs with placeholder adapters behind `VINYL_DEMO=1` so a developer can see an end-to-end
 * PROPOSED Quote in the UI without fabricating picks on the default path.
 *
 * Usage: `npm run agent:run [-- --trigger scheduled]`  (set VINYL_DEMO=1 for a demo pick)
 */
import { pathToFileURL } from "node:url";
import type { BrainAdapter, BrainContext, OwnedAlbumContext, PricingAdapter } from "@/adapters/types";
import { FakeBrainAdapter, FakePricingAdapter } from "@/adapters/fakes";
import { openDb, resolveDbPath } from "@/store/db";
import { Store } from "@/store/store";
import { formatGBP } from "@/store/money";
import { albumKey, type ChaosDial, type OrderRow, type RunTrigger } from "@/store/types";
import { pickRecord } from "./picker";

function parseTrigger(argv: string[]): RunTrigger {
  const i = argv.indexOf("--trigger");
  const value = i >= 0 ? argv[i + 1] : undefined;
  return value === "scheduled" ? "scheduled" : "manual";
}

/** genres/styles are stored as JSON-encoded arrays; tolerate null/garbage on read. */
function parseTags(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Assemble the Brain's taste context from the spine. `owned` is the full Owned set the
 * picker must never re-buy: the synced collection (rich, with genres + the ratings/notes
 * learning signal) PLUS the app's own purchases (ORDERED/ARRIVED) — CONTEXT.md → Owned set.
 */
export function buildTaste(store: Store, chaosDial: ChaosDial): BrainContext {
  const ratings = new Map(store.ratings.all().map((r) => [r.album_key, r.rating]));
  const owned: OwnedAlbumContext[] = store.collection.all().map((row) => ({
    artist: row.artist,
    title: row.title,
    genres: parseTags(row.genres),
    styles: parseTags(row.styles),
    rating: ratings.get(row.album_key),
    notes: store.notes.listFor(row.album_key).map((n) => n.body),
  }));
  // The app's own purchases count as owned even before they're logged back to Discogs.
  for (const status of ["ORDERED", "ARRIVED"] as const) {
    for (const o of store.orders.listByStatus(status)) {
      owned.push({ artist: o.artist, title: o.title });
    }
  }
  return {
    owned,
    rejectedKeys: store.rejected.all().map((r) => r.album_key),
    chaosDial,
  };
}

export interface GapFillDeps {
  brain: BrainAdapter;
  pricing: PricingAdapter;
  /** Injected randomness seed — fixes the picker's lane selection for this Run. */
  seed: number;
}

export interface GapFillOutcome {
  runId: number;
  /** The PROPOSED Quote, when one was landed within budget. */
  order?: OrderRow;
  /** How many records went to the Rejected log this Run. */
  rejected: number;
}

/** Run the default Gap-fill pick. Returns null without running if buying is Paused. */
export async function runGapFill(
  store: Store,
  deps: GapFillDeps,
  trigger: RunTrigger,
): Promise<GapFillOutcome | null> {
  if (store.config.isPaused()) {
    console.log("Paused — skipping Run (no future buying while paused).");
    return null;
  }

  const config = store.config.get();
  const run = store.runs.create(trigger);

  const result = await pickRecord({
    brain: deps.brain,
    pricing: deps.pricing,
    taste: buildTaste(store, config.chaosDial),
    budget: {
      balancePence: store.ledger.balance(),
      ceilingPence: config.perPurchaseCeilingPence,
    },
    seed: deps.seed,
  });

  // Everything the Brain wanted but couldn't land this Run → Rejected log (so future Runs
  // don't re-suggest it, and a pricey reject can be revisited by a later Splurge).
  for (const r of result.rejected) {
    store.rejected.add({
      album_key: albumKey(r.artist, r.title),
      artist: r.artist,
      title: r.title,
      lane: r.lane,
      reason: r.reason,
      source: r.source ?? null,
      listing_url: r.listingUrl ?? null,
      quoted_price_pence: r.quotedPricePence ?? null,
      run_id: run.id,
    });
  }

  if (!result.ok) {
    store.runs.finish(
      run.id,
      "finished",
      `Nothing landed within budget this Run; ${result.rejected.length} record(s) rejected.`,
    );
    return { runId: run.id, rejected: result.rejected.length };
  }

  const q = result.quote;
  const order = store.orders.propose({
    run_id: run.id,
    album_key: albumKey(q.artist, q.title),
    artist: q.artist,
    title: q.title,
    lane: q.lane,
    intent: "gap_fill",
    why: q.why,
    source: q.source,
    listing_url: q.listingUrl,
    quoted_price_pence: q.landedPricePence,
    discogs_release_id: q.discogsReleaseId ?? null,
  });
  // Summary keeps the surprise: source + price, never the title (CONTEXT.md → Two-phase buy).
  store.runs.finish(
    run.id,
    "finished",
    `Proposed a ${q.lane} pick from ${q.source} at ${formatGBP(q.landedPricePence)} — pending approval.`,
  );
  return { runId: run.id, order, rejected: result.rejected.length };
}

/**
 * Placeholder Brain + pricing for `VINYL_DEMO=1` only, so the end-to-end PROPOSED Quote is
 * visible in the UI before the real Brain and the real Discogs/Amazon lookup (#6) land. The
 * canned candidates are an obvious demo, not a recommender.
 */
function demoDeps(): GapFillDeps {
  const brain = new FakeBrainAdapter([
    { artist: "Alice Coltrane", title: "Journey in Satchidananda", lane: "stretch", why: "a canonical spiritual-jazz on-ramp for a collection with almost no jazz" },
    { artist: "Curtis Mayfield", title: "Super Fly", lane: "adjacent", why: "soul/funk one step out from the golden-age hip-hop spine" },
    { artist: "The Beatles", title: "Let It Be", lane: "complete", why: "completes the Beatles solar system at album level" },
  ]);
  const pricing = new FakePricingAdapter();
  pricing.setListings("Alice Coltrane", "Journey in Satchidananda", [
    { source: "amazon", listingUrl: "https://amazon.example/satchidananda", landedPricePence: 2899, available: true },
    { source: "discogs", listingUrl: "https://discogs.example/satchidananda", landedPricePence: 2650, available: true },
  ]);
  pricing.setListings("Curtis Mayfield", "Super Fly", [
    { source: "discogs", listingUrl: "https://discogs.example/superfly", landedPricePence: 3200, available: true },
  ]);
  pricing.setListings("The Beatles", "Let It Be", [
    { source: "amazon", listingUrl: "https://amazon.example/letitbe", landedPricePence: 2400, available: true },
  ]);
  return { brain, pricing, seed: 1 };
}

async function main(): Promise<void> {
  const trigger = parseTrigger(process.argv.slice(2));
  const path = resolveDbPath();
  const db = openDb(path);
  try {
    const store = new Store(db);

    if (process.env.VINYL_DEMO !== "1") {
      // Default path: real pricing (#6) ships, but the real Brain (Claude in-context) isn't
      // wired yet, so there's nothing to price. Record the Run honestly rather than fabricating.
      const run = store.runs.create(trigger);
      store.runs.finish(
        run.id,
        "finished",
        "Real Brain not yet wired (pricing #6 shipped). Re-run with VINYL_DEMO=1 for a demo pick.",
      );
      console.log(`Run #${run.id} (${trigger}) recorded — set VINYL_DEMO=1 to see a demo PROPOSED quote.`);
      return;
    }

    // Demo: give the war chest something to spend if it's empty, then make a real pick.
    if (store.ledger.balance() <= 0) {
      store.ledger.append({
        entry_type: "cap_added",
        amount_pence: store.config.get().monthlyCapPence,
        note: "demo: seed war chest so the demo pick is affordable",
      });
    }
    const outcome = await runGapFill(store, demoDeps(), trigger);
    if (outcome?.order) {
      console.log(
        `Run #${outcome.runId}: PROPOSED a pick from ${outcome.order.source} at ` +
          `${formatGBP(outcome.order.quoted_price_pence)} (title hidden). Open the UI to approve.`,
      );
    } else if (outcome) {
      console.log(`Run #${outcome.runId}: nothing affordable (${outcome.rejected} rejected).`);
    }
  } finally {
    db.close();
  }
}

// Only run when invoked as a script, not when imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
