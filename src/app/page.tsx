import { getStore } from "@/lib/store-instance";
import { formatGBP } from "@/store/money";

// The spine changes outside the request lifecycle (the agent writes to it), so never
// cache this page — always read the live file.
export const dynamic = "force-dynamic";

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

export default function Home() {
  const store = getStore();
  const runs = store.runs.list(10);
  const config = store.config.get();
  const balancePence = store.ledger.balance();
  const collection = store.collection.all();

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
            {collection.map((row) => {
              const tags = [...parseTags(row.genres), ...parseTags(row.styles)];
              return (
                <li
                  key={row.id}
                  className="rounded-lg border border-neutral-800 bg-neutral-900/40 px-4 py-3"
                >
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
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
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
