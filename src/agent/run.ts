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
 * Scheduling (issue #11): Windows Task Scheduler fires this via two jobs (scripts/register-task.ps1)
 * — a monthly cadence trigger that runs unconditionally (StartWhenAvailable reruns a start missed
 * because the machine was off, so no month is silently skipped), and an at-logon catch-up that
 * passes `--if-due` so it only runs when a month is genuinely overdue. `--if-due` gates on the last
 * *scheduled* Run via `monthlyRunDue`; without the flag (the monthly job, or a manual "Run now")
 * the Run always fires.
 *
 * Usage: `npm run agent:run [-- --trigger scheduled] [--if-due]`  (set VINYL_DEMO=1 for a demo pick)
 */
import { pathToFileURL } from "node:url";
import type {
  BrainAdapter,
  BrainContext,
  NotificationAdapter,
  OwnedAlbumContext,
  PricingAdapter,
} from "@/adapters/types";
import { FakeBrainAdapter, FakePricingAdapter } from "@/adapters/fakes";
import { notificationAdapterFromEnv } from "@/adapters/notify";
import { openDb, resolveDbPath } from "@/store/db";
import { Store } from "@/store/store";
import { formatGBP } from "@/store/money";
import { albumKey, type ChaosDial, type Config, type OrderRow, type RunRow, type RunTrigger } from "@/store/types";
import { mulberry32, pickRecord } from "./picker";
import { pickSplurge } from "./splurge";
import { monthlyRunDue } from "./schedule";

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
  /**
   * Raises the "a record is on its way" desktop nudge when a PROPOSED Quote is parked
   * (CONTEXT.md → Two-phase buy). Optional so the picker/store seams stay testable without
   * it; the scheduled Run and the STALE re-pick wire a real notifier so Euan is pulled in.
   */
  notifier?: NotificationAdapter;
}

export interface GapFillOutcome {
  runId: number;
  /** The PROPOSED Quote, when one was landed within budget. */
  order?: OrderRow;
  /** How many records went to the Rejected log this Run. */
  rejected: number;
}

/**
 * Run the default Gap-fill pick on its own fresh Run. Returns null without running if Paused.
 * This is the entry the STALE re-pick (lifecycle.ts) calls — it deliberately does *not* accrue
 * the monthly cap (a re-pick must never mint another month's funds); `runMonthly` owns accrual.
 */
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
  return proposeGapFillOnRun(store, deps, run, config);
}

/**
 * The Gap-fill body, operating on an *already-created* Run — so `runMonthly` can accrue the
 * cap and decide Splurge-vs-Gap-fill against one Run, and `runGapFill` can drive a fresh one.
 * Calls the pure `pickRecord`, logs the "wanted but couldn't land" records to Rejected, and
 * parks the winner as a PROPOSED Quote (a quote, not a held cart — ADR-0003).
 */
async function proposeGapFillOnRun(
  store: Store,
  deps: GapFillDeps,
  run: RunRow,
  config: Config,
): Promise<GapFillOutcome> {
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
  await notifyProposed(deps, order);
  return { runId: run.id, order, rejected: result.rejected.length };
}

/**
 * Pull Euan in for the irreducible payment step. Title-hiding by design: the notifier only ever
 * sees price + source. A notification failure must never undo a parked Quote — the built-in
 * adapters swallow their own errors (see notify.ts); this guards a custom one that throws too.
 */
async function notifyProposed(deps: GapFillDeps, order: OrderRow): Promise<void> {
  if (!deps.notifier) return;
  try {
    await deps.notifier.proposed({
      orderId: order.id,
      source: order.source,
      pricePence: order.quoted_price_pence,
    });
  } catch (err) {
    console.warn("[run] proposed-order notification failed:", err);
  }
}

/** The buy intent a Run settled on, surfaced to callers/tests (the *what*, not the chaos). */
export type RunIntent = "gap_fill" | "splurge";

export interface MonthlyOutcome {
  runId: number;
  intent: RunIntent;
  /** The PROPOSED Quote, when one was landed within budget. */
  order?: OrderRow;
  /** How many records went to the Rejected log this Run (Gap-fill path only). */
  rejected: number;
}

/**
 * The monthly Run orchestrator (issue #8) — the single entrypoint the scheduler/"Run now" drive.
 * It owns the money model around the pick:
 *   1. short-circuit if Paused (no Run row, no accrual);
 *   2. accrue the monthly cap into the war chest (idempotent per Run; carry-over is automatic);
 *   3. *occasionally* Splurge — but only when the chest can clear a Rejected-log item under the
 *      ceiling (CONTEXT.md → Buy intent). The "occasionally" is the seeded `splurgeChancePercent`
 *      roll; the affordability gate is the hard rule. A landed Splurge clears its record off the
 *      Rejected log so the thing once unaffordable finally arrives;
 *   4. otherwise fall through to the default Gap-fill pick on the same Run.
 */
export async function runMonthly(
  store: Store,
  deps: GapFillDeps,
  trigger: RunTrigger,
): Promise<MonthlyOutcome | null> {
  if (store.config.isPaused()) {
    console.log("Paused — skipping Run (no future buying while paused).");
    return null;
  }

  const config = store.config.get();
  const run = store.runs.create(trigger);
  store.ledger.accrueCap(run.id, config.monthlyCapPence);

  const balancePence = store.ledger.balance();
  const ceilingPence = config.perPurchaseCeilingPence;
  const ownedKeys = new Set(store.owned.keys());

  // Splurge competes for the slot only when the chest can clear a wishlist item under the
  // ceiling — and even then only on the occasional seeded roll, so it stays a treat.
  if (shouldAttemptSplurge(deps.seed, config.splurgeChancePercent)) {
    const wishlist = store.rejected
      .splurgeWishlist()
      .filter((c) => !ownedKeys.has(c.album_key))
      .map((c) => ({
        album_key: c.album_key,
        artist: c.artist,
        title: c.title,
        lane: c.lane,
        quotedPricePence: c.quoted_price_pence,
      }));
    if (wishlist.length > 0) {
      const splurge = await pickSplurge({
        pricing: deps.pricing,
        candidates: wishlist,
        ownedKeys,
        budget: { balancePence, ceilingPence },
      });
      if (splurge.ok) {
        const q = splurge.quote;
        const order = store.orders.propose({
          run_id: run.id,
          album_key: q.album_key,
          artist: q.artist,
          title: q.title,
          lane: q.lane ?? null,
          intent: "splurge",
          why: "A war-chest Splurge — finally clearing a record the chest couldn't reach before.",
          source: q.source,
          listing_url: q.listingUrl,
          quoted_price_pence: q.landedPricePence,
          discogs_release_id: q.discogsReleaseId ?? null,
        });
        // It's now a live order, not a reject: clear it off the Rejected log / Splurge wishlist.
        // (A later STALE/Decline re-adds it, so this can't strand the record.)
        store.rejected.clearAlbum(q.album_key);
        store.runs.finish(
          run.id,
          "finished",
          `Proposed a Splurge from ${q.source} at ${formatGBP(q.landedPricePence)} — pending approval.`,
        );
        await notifyProposed(deps, order);
        return { runId: run.id, intent: "splurge", order, rejected: 0 };
      }
    }
  }

  const gap = await proposeGapFillOnRun(store, deps, run, config);
  return { runId: run.id, intent: "gap_fill", order: gap.order, rejected: gap.rejected };
}

/**
 * The occasional-Splurge roll: deterministic off the Run's injected seed, so tests fix it.
 * The seed is XORed with a constant before seeding the PRNG so this draw is its own stream,
 * decorrelated from any other seeded draw in the Run (e.g. the picker's lane ordering).
 */
function shouldAttemptSplurge(seed: number, chancePercent: number): boolean {
  if (chancePercent <= 0) return false;
  if (chancePercent >= 100) return true;
  const rng = mulberry32((seed ^ 0x53504c47) >>> 0); // 0x53504c47 = "SPLG"
  return rng() * 100 < chancePercent;
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
  return { brain, pricing, seed: 1, notifier: notificationAdapterFromEnv() };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const trigger = parseTrigger(argv);
  const ifDue = argv.includes("--if-due");
  const path = resolveDbPath();
  const db = openDb(path);
  try {
    const store = new Store(db);

    // Catch-up guard (issue #11): only the at-logon catch-up passes `--if-due`, so a logon the day
    // after a Run is a no-op while a logon after a month-off catches the missed beat. The monthly
    // cadence job runs without this flag. No Run row is written when skipped — nothing was owed.
    if (ifDue && !monthlyRunDue(store.runs.lastScheduledAt(), new Date())) {
      console.log("Monthly Run already done for this period — skipping (--if-due).");
      return;
    }

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

    // runMonthly accrues the monthly cap itself, so the war chest funds the demo pick.
    const outcome = await runMonthly(store, demoDeps(), trigger);
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
