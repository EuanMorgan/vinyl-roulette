import { getStore } from "@/lib/store-instance";
import { formatGBP } from "@/store/money";

// The spine changes outside the request lifecycle (the agent writes to it), so never
// cache this page — always read the live file.
export const dynamic = "force-dynamic";

export default function Home() {
  const store = getStore();
  const runs = store.runs.list(10);
  const config = store.config.get();
  const balancePence = store.ledger.balance();

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
