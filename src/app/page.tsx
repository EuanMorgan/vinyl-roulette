import { getStore } from "@/lib/store-instance";
import { formatGBP } from "@/store/money";
import type { LedgerActivityEvent, TasteRow } from "@/store/types";
import { addNoteAction, clearRatingAction, setRatingAction } from "./actions";

// The spine changes outside the request lifecycle (the agent writes to it), so never
// cache this page — always read the live file.
export const dynamic = "force-dynamic";

export default function Home() {
  const store = getStore();
  const runs = store.runs.list(10);
  const config = store.config.get();
  const balancePence = store.ledger.balance();
  const collection = store.collection.withTaste();
  const proposed = store.orders.listByStatus("PROPOSED");
  const activity = store.ledger.activity(50);

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">Vinyl Roulette</h1>
        <p className="mt-1 text-sm text-neutral-400">
          One surprise record a month. The money is transparent; only the music is a secret.
        </p>
      </header>

      <section className="mb-8 grid grid-cols-2 gap-4 text-sm">
        <Stat label="War-chest balance" value={formatGBP(balancePence)} />
        <Stat label="Monthly cap" value={formatGBP(config.monthlyCapPence)} />
        <Stat label="Per-purchase ceiling" value={formatGBP(config.perPurchaseCeilingPence)} />
        <Stat label="Status" value={config.paused ? "Paused" : "Active"} />
      </section>

      {proposed.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-neutral-400">
            Pending approval
          </h2>
          <ul className="space-y-2">
            {proposed.map((order) => (
              // The surprise: show price + source ONLY, never the title or the why
              // (CONTEXT.md → Two-phase buy). Euan authorises the spend, not the record.
              <li
                key={order.id}
                className="rounded-lg border border-amber-900/60 bg-amber-950/20 px-4 py-3"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-medium text-amber-200">
                    A record is on its way 🎉
                  </span>
                  <span className="text-lg font-semibold">
                    {formatGBP(order.quoted_price_pence)}
                  </span>
                </div>
                <p className="mt-1 text-sm text-neutral-400">
                  Approve {formatGBP(order.quoted_price_pence)} at{" "}
                  <span className="capitalize text-neutral-200">{order.source}</span>. The
                  title stays a secret until it arrives.
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-neutral-400">
          Runs
        </h2>
        {runs.length === 0 ? (
          <p className="rounded-lg border border-neutral-800 bg-neutral-900/40 px-4 py-6 text-sm text-neutral-400">
            No runs yet. Trigger one with <code className="text-neutral-200">npm run agent:run</code>,
            then refresh — this row is the end-to-end demo (agent writes, UI reads).
          </p>
        ) : (
          <ul className="space-y-2">
            {runs.map((run) => (
              <li
                key={run.id}
                className="rounded-lg border border-neutral-800 bg-neutral-900/40 px-4 py-3"
              >
                <div className="flex items-baseline justify-between">
                  <span className="font-medium">
                    Run #{run.id}{" "}
                    <span className="text-xs text-neutral-500">({run.trigger})</span>
                  </span>
                  <span className="text-xs text-neutral-500">{run.status}</span>
                </div>
                {run.summary && (
                  <p className="mt-1 text-sm text-neutral-400">{run.summary}</p>
                )}
                <p className="mt-1 text-xs text-neutral-600">{run.started_at}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-8">
        <h2 className="mb-3 flex items-baseline justify-between text-sm font-medium uppercase tracking-wide text-neutral-400">
          <span>Spend ledger</span>
          <span className="text-xs font-normal normal-case text-neutral-600">
            running balance {formatGBP(balancePence)}
          </span>
        </h2>
        {/* The always-on transparency backstop (CONTEXT.md → Spend ledger): every quote,
            approval, and order, plus every funds movement with the war-chest balance after it.
            The money is fully transparent; only the music is a secret. */}
        {activity.length === 0 ? (
          <p className="rounded-lg border border-neutral-800 bg-neutral-900/40 px-4 py-6 text-sm text-neutral-400">
            No entries yet. The monthly cap is accrued into the war chest on each Run, and every
            quote, approval, and order is recorded here.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {activity.map((event, i) => (
              <LedgerActivityItem key={`${event.kind}-${event.orderId ?? "x"}-${i}`} event={event} />
            ))}
          </ul>
        )}
      </section>

      <section className="mt-8">
        <h2 className="mb-3 flex items-baseline justify-between text-sm font-medium uppercase tracking-wide text-neutral-400">
          <span>Collection</span>
          <span className="text-xs font-normal lowercase text-neutral-600">
            {collection.length} {collection.length === 1 ? "record" : "records"}
          </span>
        </h2>
        {collection.length === 0 ? (
          <p className="rounded-lg border border-neutral-800 bg-neutral-900/40 px-4 py-6 text-sm text-neutral-400">
            No collection synced yet. Pull your Discogs library with{" "}
            <code className="text-neutral-200">npm run discogs:sync</code> (set{" "}
            <code className="text-neutral-200">DISCOGS_USERNAME</code> and{" "}
            <code className="text-neutral-200">DISCOGS_TOKEN</code> first), then refresh.
          </p>
        ) : (
          <ul className="space-y-2">
            {collection.map((row) => (
              <CollectionItem key={row.album_key} row={row} />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

/**
 * One collection album with its taste controls. Rating and notes apply to any record
 * (not just purchased ones) — the "ownership is not endorsement" feedback loop. The
 * forms post directly to server actions, so this works without client-side JS.
 */
function CollectionItem({ row }: { row: TasteRow }) {
  const tags = [...row.genres, ...row.styles];
  const hidden = (
    <>
      <input type="hidden" name="album_key" value={row.album_key} />
      <input type="hidden" name="artist" value={row.artist} />
      <input type="hidden" name="title" value={row.title} />
    </>
  );

  return (
    <li className="rounded-lg border border-neutral-800 bg-neutral-900/40 px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium">
          {row.artist} <span className="text-neutral-500">—</span> {row.title}
        </span>
        {row.year && <span className="text-xs text-neutral-600">{row.year}</span>}
      </div>

      {tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full border border-neutral-800 px-2 py-0.5 text-xs text-neutral-400"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Rating: each star is a submit button posting its value. An unrated record shows
          empty stars — owning it says nothing about whether Euan loves it. A rated record
          can be cleared back to no-signal (null), never silently coerced to a low score. */}
      <div className="mt-3 flex items-center gap-2">
        <form action={setRatingAction} className="flex items-center gap-2">
          {hidden}
          <div className="flex gap-0.5">
            {[1, 2, 3, 4, 5].map((n) => {
              const filled = row.rating !== null && n <= row.rating;
              return (
                <button
                  key={n}
                  type="submit"
                  name="rating"
                  value={n}
                  aria-label={`Rate ${n} of 5`}
                  aria-pressed={row.rating === n}
                  className={`text-lg leading-none transition-colors ${
                    filled ? "text-amber-400" : "text-neutral-700 hover:text-neutral-500"
                  }`}
                >
                  ★
                </button>
              );
            })}
          </div>
          <span className="text-xs text-neutral-600">
            {row.rating !== null ? `${row.rating}/5` : "unrated"}
          </span>
        </form>
        {row.rating !== null && (
          <form action={clearRatingAction}>
            <input type="hidden" name="album_key" value={row.album_key} />
            <button
              type="submit"
              className="text-xs text-neutral-600 underline-offset-2 hover:text-neutral-400 hover:underline"
            >
              clear
            </button>
          </form>
        )}
      </div>

      {row.notes.length > 0 && (
        <ul className="mt-3 space-y-1 border-l border-neutral-800 pl-3">
          {row.notes.map((note, i) => (
            <li key={i} className="text-sm text-neutral-300">
              {note}
            </li>
          ))}
        </ul>
      )}

      <form action={addNoteAction} className="mt-3 flex gap-2">
        {hidden}
        <input
          type="text"
          name="body"
          placeholder="Add a note…"
          className="flex-1 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
        />
        <button
          type="submit"
          className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800"
        >
          Add
        </button>
      </form>
    </li>
  );
}

/** One spend-ledger row. Money events (cap/order/refund/adjustment) show a signed amount + the
 *  war-chest balance after them; lifecycle events (quote/approval/arrival) show the source. The
 *  label keeps the surprise — it names the *kind* and source, never the record title. */
function LedgerActivityItem({ event }: { event: LedgerActivityEvent }) {
  const labels: Record<LedgerActivityEvent["kind"], string> = {
    cap_added: "Monthly cap added",
    order_placed: "Order placed",
    refund: "Refund",
    adjustment: "Adjustment",
    quote: "Quote parked — pending approval",
    approved: "Approved",
    arrived: "Arrived",
  };
  const hasAmount = event.amountPence !== undefined;
  const credit = (event.amountPence ?? 0) >= 0;
  return (
    <li className="flex items-baseline justify-between gap-3 rounded-lg border border-neutral-800 bg-neutral-900/40 px-4 py-2.5 text-sm">
      <div className="min-w-0">
        <span className="text-neutral-200">{labels[event.kind]}</span>
        {event.source && (
          <span className="ml-2 text-xs capitalize text-neutral-500">{event.source}</span>
        )}
        {event.note && <span className="ml-2 text-xs text-neutral-500">{event.note}</span>}
        <div className="text-xs text-neutral-600">{event.at}</div>
      </div>
      {hasAmount && (
        <div className="shrink-0 text-right">
          <div className={credit ? "font-medium text-emerald-400" : "font-medium text-neutral-300"}>
            {credit ? "+" : "−"}
            {formatGBP(Math.abs(event.amountPence!))}
          </div>
          {event.balanceAfterPence !== undefined && (
            <div className="text-xs text-neutral-600">
              balance {formatGBP(event.balanceAfterPence)}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
    </div>
  );
}
