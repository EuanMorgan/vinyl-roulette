# 1. The app is a scheduled local Claude Code agent, not a hosted service

Date: 2026-06-24

## Status
Accepted

## Context
The app must, monthly: understand Euan's taste, find gaps, choose a record, find the
cheapest source, buy it, and explain itself later. The "obvious" build is a hosted web
service with a trained/heuristic recommender, a gap-detection algorithm, and a
catalog-matching pipeline.

Euan instead wants it to run as **local Claude Code, invoked programmatically on a
schedule** (roughly monthly), on his own machine.

## Decision
The Brain is Claude reasoning in-context during each scheduled Run — not a bespoke
recommendation engine. Discogs provides the data (collection, genres, styles); Claude
provides the taste judgement, gap analysis, and lane choice each Run. Browser automation
on the same local machine acts as the Hands to execute the purchase.

State persists between Runs in a shared store (ratings, notes, spend ledger, rejected
log) that both the agent and the UI read/write.

## Consequences
- **Dissolves the hardest "product" problems:** no ML taste model, no cold-start, no
  gap-detection algorithm, no recommendation-quality tuning. Claude does it in-context.
- **Runs locally** so the browser-automation buy step can reuse Euan's already-
  authenticated Amazon/Discogs/PayPal session — the only sane way to clear checkout +
  payment 2FA.
- **The UI cannot live inside the CLI agent.** A separate persistent app (the "nice UI")
  is needed for reveal/notes/ratings; it communicates with the agent only through the
  shared store. (Open question — see grilling.)
- **Reliability is best-effort.** A scheduled local job only runs when the machine is on;
  Euan has accepted occasional breakage ("personal project, not bothered if it breaks").
- **Non-determinism is a feature here**, not a bug — the chaos is the point.
- **Auth = subscription, not API key.** The scheduled `claude -p` authenticates via
  `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), so Runs draw on Euan's Pro/Max
  subscription rather than metered API billing. Constraints: do **not** pass `--bare`
  (it forces an API key); the token expires yearly (annual regen chore); OAuth tokens
  aren't auto-refreshed in long headless runs (~10-15 min limit), so each Run must stay
  short — a natural fit for the decide→price→cart and the separate payment invocations.
