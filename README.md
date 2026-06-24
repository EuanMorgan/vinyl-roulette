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

## Configuration

`VINYL_DB_PATH` overrides the SQLite location (default `./data/vinyl.db`). See `.env.example`.
