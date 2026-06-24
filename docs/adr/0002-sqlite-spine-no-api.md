# 2. Shared SQLite file is the spine; agent and UI are two clients of it

Date: 2026-06-24

## Status
Accepted

## Context
Three components must coexist: the scheduled headless agent (Claude Code, ~monthly), a
local web UI (opened on demand), and shared state (ratings, notes, spend ledger,
war-chest balance, rejected log, per-record ordered/arrived status). The agent and UI
never run at the same time and never need to call each other.

## Decision
The state lives in a **single local SQLite file**. Both the agent and the UI open that
file directly — there is **no API or service between them**. The store is the spine; the
agent and UI are independent clients that meet only at the file.

UI = local web app (React + shadcn/ui, Next.js or TanStack Start — undecided, low stakes)
on `localhost`, launched on demand, not always-on, not hosted. Styled with shadcn — this
is a personal project, **not** tied to the zeroheight design system.

## Consequences
- **No backend to build.** No REST/GraphQL layer, no auth between processes. SQLite via
  `better-sqlite3` in server-side code on the UI side; direct file access on the agent side.
- **Concurrency is a non-issue in practice** — agent and UI don't run simultaneously, and
  SQLite's file locking covers the rare overlap.
- **Single-user, single-machine by definition.** No multi-user, no cloud sync. Acceptable:
  it's a personal toy for one shelf.
- **The store schema is the real contract** — both clients must agree on it, so it's the
  thing worth designing carefully.
