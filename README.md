# Vinyl Roulette

A personal app that watches Euan's vinyl collection, finds gaps in his taste, and
autonomously buys one record a month as a surprise. See `CONTEXT.md` for the glossary and
`docs/adr/` for the load-bearing decisions; `PRD` lives in GitHub issue #1.

## Architecture (the walking skeleton)

Two independent clients meet at a single local **SQLite file** with **no API between them**
(ADR-0002). The store schema is the real contract.

- **`src/store/`** — framework-agnostic spine. `migrations.ts` is the schema; `store.ts` is
  the typed repository layer both clients use; money is integer **pence** everywhere.
- **`src/adapters/`** — the seam convention. Discogs sync, cross-source pricing, and the
  Playwright buy each sit behind a thin interface (`types.ts`); tests inject fakes
  (`fakes.ts`) at that boundary. See `src/adapters/README.md`.
- **`src/agent/run.ts`** — the headless entrypoint the scheduled `claude -p` drives
  (ADR-0001). Opens the store directly and records a Run.
- **`src/app/`** — the local Next.js UI (`localhost`, on demand). Reads the spine
  server-side via `src/lib/store-instance.ts`.

## Commands

```bash
npm install
npm run db:migrate     # apply schema to ./data/vinyl.db (idempotent)
npm run agent:run      # the agent writes a Run row (add: -- --trigger scheduled)
npm run dev            # the UI reads it back at http://localhost:3000
npm run typecheck
npm test
```

End-to-end demo: `npm run agent:run` then load the UI — the Run row the agent wrote
appears under "Runs".

## Scheduling (issue #11)

The monthly Run is fired by **Windows Task Scheduler**, locally, so the buy step reuses Euan's
logged-in Chrome/Amazon/Discogs/PayPal sessions (ADR-0001, never deployed). Register the job:

```powershell
pwsh -File scripts/register-task.ps1          # monthly on the 1st at 09:00
pwsh -File scripts/register-task.ps1 -Time 08:30 -DayOfMonth 2
pwsh -File scripts/register-task.ps1 -Unregister
```

It creates two tasks, both running `scripts/run-agent.ps1`:

- **`VinylRoulette-MonthlyRun`** — a monthly trigger (the cadence), run *unconditionally*
  (`-Trigger scheduled`). `StartWhenAvailable` reruns a start the machine was off for as soon as
  it's back, so a missed month runs at next boot — never silently skipped.
- **`VinylRoulette-Catchup`** — an at-logon trigger, run with the `--if-due` guard
  (`monthlyRunDue`), so it only fires when a month is genuinely overdue and is a no-op on ordinary
  sign-ins. Gating the catch-up but not the cadence is deliberate: a guard on the monthly fire
  could suppress a legitimate month when the prior Run was itself a late catch-up.

Runs are capped at 15 minutes to stay inside the OAuth headless window.

- **Run now** — the button in the UI fires the same entrypoint on demand (`manual` trigger, no
  catch-up gate), spawned detached so it writes to SQLite even with the page closed.
- **Auth** — the scheduled `claude -p` Run authenticates via `CLAUDE_CODE_OAUTH_TOKEN` (Euan's
  Pro/Max subscription). `run-agent.ps1` loads it from `.env`; `--bare` is never passed (it would
  force a metered API key — ADR-0001). The token is regenerated yearly with `claude setup-token`.

> The in-context Brain ships: the Node entrypoint (`npm run agent:run`) builds the real
> `ClaudeBrainAdapter`, which runs `claude -p` as a subprocess to propose each month's candidates
> (gated on `CLAUDE_CODE_OAUTH_TOKEN`). `VINYL_AGENT_CMD` remains an escape hatch to point the Run
> at an alternate agent command, but is no longer required.

## Configuration

`VINYL_DB_PATH` overrides the SQLite location (default `./data/vinyl.db`). `VINYL_AGENT_CMD`
overrides the Run command (default `npm run agent:run`). See `.env.example`.
