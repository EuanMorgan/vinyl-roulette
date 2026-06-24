# 3. Runs locally only; purchase is a two-phase auto-prep + attended-payment split

Date: 2026-06-24

## Status
Accepted

## Context
The buyer must clear a real checkout including payment, which routinely triggers 2FA /
PayPal / CVV challenges that an unattended job cannot pass. Hosting on a VPS (Coolify)
was considered for "always runs" reliability.

## Decision
**Run locally only — do not deploy.** A VPS reintroduces fresh-login + 2FA walls every
run and removes the human who can clear them; local execution reuses Euan's already-
authenticated browser sessions and keeps him at hand for the payment challenge.

A local scheduler (Windows Task Scheduler) fires the monthly Run, so Euan need not
remember to start it. The purchase is split across the human-in-the-loop boundary:

1. **Auto-prep (unattended):** decide record, price sources, drive Playwright to the
   payment button, park as PENDING APPROVAL, notify.
2. **Payment (attended):** Euan approves (price + source only, no title) and clears 2FA;
   Playwright finalizes.

## Consequences
- Reliability depends on the machine being on; a missed monthly trigger runs at next boot.
  Acceptable at monthly cadence.
- The human is in the loop by design every month — "fully unattended" was never viable
  given payment security, so the confirm tap costs nothing extra and preserves the surprise.
- **Staleness risk — resolved:** auto-prep stores a *quote* (record, source, listing URL,
  price), not a held cart. At approval, Playwright re-opens fresh and re-validates; if the
  listing is gone or price drifted >£3 over quote, the order goes STALE and the picker
  re-runs rather than silently buying the wrong thing. See CONTEXT "Order lifecycle".
