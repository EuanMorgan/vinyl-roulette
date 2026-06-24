# Context — Vinyl Auto-Buy

Glossary for a personal app that watches Euan's vinyl collection, finds gaps in his taste, and autonomously buys one record a month as a surprise.

## Glossary

### Collection / Owned set
The records that count as "already owned" for dupe-avoidance, matched at **album level** (artist + title), *not* pressing level — owning any pressing of an album means the app will never buy that album again. Buying multiple pressings is a personal collector's choice the app deliberately stays out of; its job is **expanding taste**, not deepening sets.

The Owned set = Euan's **Discogs library** (read-synced) ∪ the app's own **purchase ledger** (records it has ordered). The app's DB is authoritative for what it has bought; Discogs is the source of truth for what Euan logged himself.

### Complete lane (refined)
"Complete" means finish an **artist/series at album level** (e.g. owns 9 Beatles LPs but not *Let It Be* → get it), never "get a different pressing of an album you already have."

### Catalog
The universe of records the app can *buy from*. Two sources: **Discogs Marketplace** (used/rare, condition-graded, per-seller shipping) and **Amazon** (new repressings, Prime shipping). For a chosen record, the app buys from whichever source is cheaper on **total landed cost** (item + shipping), subject to guardrails. Distinct from the Collection.

### Landed cost
Item price + shipping to Euan, in GBP. The figure compared across sources and checked against the budget cap. *Not* the sticker price alone — Discogs per-seller (often international) shipping can flip which source is cheaper.

### Brain vs Hands
- **Brain** = Claude itself, reasoning in-context each Run over the Collection + Notes/Ratings + Rejected log. There is no trained model or bespoke recommender; Discogs supplies the data (genres/styles/collection), Claude supplies the judgement.
- **Hands** = Discogs Marketplace *or* Amazon, whichever is cheaper for the chosen record (source-selector — see below). Purchase executed via browser automation.

### Run
One scheduled invocation of the local Claude Code agent (~monthly), fired by Windows Task Scheduler. Runs locally (never deployed) so it reuses Euan's logged-in Chrome/Amazon/Discogs/PayPal sessions. Decoupled from the UI — runs even with the UI closed, writing results to the SQLite store. Also triggerable via a "Run now" button for first-run/debugging.

### Two-phase buy
The purchase splits across the human-in-the-loop boundary:
- **Auto-prep (unattended):** the Run picks the record, prices Discogs vs Amazon, drives Playwright (on Euan's real Chrome profile) up to the payment button, then parks the purchase as **PENDING APPROVAL** and fires a desktop notification.
- **Payment (attended):** Euan taps to approve (sees **price + source only, never the title**), Playwright finalizes, Euan clears any 2FA/PayPal challenge. Money moves; title stays hidden until "arrived".

The title-hiding confirm gate is what keeps the surprise while letting the human clear payment auth a bot can't.

### Source-selector (price ordering)
Price decides *where* to buy, not *what* — within a chosen record. The Brain picks the record it most wants; then buys it from the cheaper source on landed cost. If that record can't be landed within budget, the Run discards it (→ Rejected log) and re-picks a *different* record, looping until one fits.

### Order lifecycle
An order moves through: **PROPOSED** (auto-prep wrote a *quote* — record, source, specific listing URL, quoted landed price; **no live cart is held**) → **APPROVED** (Euan tapped approve) → **ORDERED** (Playwright re-opened fresh, re-validated, payment cleared) → **ARRIVED** (Euan tapped "arrived", record revealed + logged to Discogs).

Escape hatch: at approval, Playwright re-checks the listing live. If it's **gone** (e.g. a one-of-one Discogs listing sold) or the price has **drifted more than £3 over the quote** (configurable), the order is marked **STALE** — it is *not* silently swapped for something else. The picker re-runs, a new PROPOSED order is written, and Euan is re-notified. The thing Euan approved is the thing bought, or he is asked again.

### Quote
What auto-prep produces and stores: the chosen record + source + specific listing URL + landed price, captured at prep time. Re-validated live before payment (see Order lifecycle). Not a held cart.

### Rejected log
Records the Brain wanted but couldn't buy this Run (over budget, or out of stock). Persisted so future Runs don't re-suggest the same thing — and so a pricey reject can be revisited later when the budget allows.

### Lane
A category of recommendation. Three lanes:
- **Complete** — finish a set already started (e.g. a missing Beatles LP).
- **Adjacent** — one step out from established taste (e.g. Wings).
- **Stretch** — deliberately out-of-lane (e.g. a jazz entry point). Defaults to a **canonical on-ramp**: for a genre Euan owns ~nothing in, the pick must be a widely-regarded classic/entry point of that genre ("what a knowledgeable friend would hand you first"), never a deep cut. **Obscurity is earned** — the agent only reaches for left-field picks within a genre once Ratings/Notes show Euan liked the on-ramps. The chaos dial modulates how far a stretch reaches, but even at max prefers "great example of the thing" over "obscure for its own sake".

### Reveal
The moment Euan discovers what was bought — when the package physically arrives. The app deliberately withholds the title. The withholding is the product, not unattended payment.

### Chaos dial
A weighting across the three Lanes controlling how adventurous the monthly pick is.

### Kill switch / control surface
Safety model for an agent with a payment method. What can be stopped depends on stage:
- **Pause** — a global UI toggle (flag in SQLite + disables the scheduled job) stops all *future* Runs.
- **Decline** — any **PROPOSED** order can be rejected before approval; no money moves, it goes to the Rejected log.
- **No automated cancellation of placed orders.** Once **ORDERED** (payment cleared), the app never attempts an auto-cancel/return — a half-successful bot return is worse than none. It surfaces the order + seller/Amazon link so Euan can cancel manually if he wants. Since every spend is approved before payment, post-order regret should be rare.

### Spend ledger
The always-on transparency backstop in the UI: every quote, approval, order, and the running war-chest balance. Nothing is ever a financial mystery — only a musical one.

### Rating / Note
User-supplied feedback attached to a record. Applies to the **entire Collection**, not just purchased records. Ratings and free-text notes are the learning signal fed back into the taste model on the next run.

### Ownership is not endorsement
Core principle of the taste model: a record being in the Collection does **not** mean Euan loves it — some are charity-shop / bargain-bin picks he tolerates. The taste model must not treat every owned record as a positive example. Ratings/Notes are how genuine affection (or dislike, or "damaged") is distinguished from mere presence.

### Budget: balance, monthly cap, per-purchase ceiling
- **Monthly cap** — the amount added to the balance each Run (~£30, configurable).
- **Balance / war chest** — monthly cap + carried-over unspent funds. What a Run can spend.
- **Per-purchase ceiling** — a configurable hard max on any *single* purchase (so a splurge can't surprise Euan with e.g. £100 gone in one go), independent of how big the balance has grown.
Total spend never exceeds allotted funds → the bank statement is never confusing, only the record is.

### Buy intent
Why a given Run is buying. Two kinds compete for the single monthly slot:
- **Gap-fill** — the normal three-lane pick (Complete / Adjacent / Stretch). The default.
- **Splurge** — clear a pricey record off the Rejected log, funded by an accumulated war chest, capped by the per-purchase ceiling. An occasional treat.

### "It's here" / Reveal screen
When a package arrives, Euan taps a "[Month]'s record arrived" button in the UI. The app then reveals: what the record is, *why* it was picked, and how it fits the Collection (which Lane, what gap it fills). The pre-reveal withholding is the surprise; this screen is the payoff.

The arrival tap is also when the record is logged to Discogs:
- **Discogs-sourced buy** → exact release ID known → one-tap auto-add to the Discogs collection.
- **Amazon-sourced buy** → no Discogs release ID → reveal screen pre-fills a best-guess Discogs release for Euan to confirm/correct in one tap.
