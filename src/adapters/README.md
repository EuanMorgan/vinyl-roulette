# Adapter seam convention

Every external dependency the agent reaches for — the Discogs collection sync, the
cross-source price/availability lookup, and the Playwright buy — sits behind a **thin
interface** in [`types.ts`](./types.ts). This is a project-wide convention established in
the walking skeleton (issue #2) and called out in the PRD's _Testing Decisions_.

## The rule

- **Production code depends on the interface, never the implementation.** A picker takes a
  `PricingAdapter`; it does not import a Discogs HTTP client or Playwright.
- **Tests inject a fake at the same boundary.** Fakes live in [`fakes.ts`](./fakes.ts) and
  are configurable data holders, not deep mocks. You set up their world (a collection, a
  price table, a "listing now gone" response) and read back what happened.
- **Keep interfaces narrow.** The boundary is "what the Brain needs", not "everything the
  API can do". If a fake is painful to write, the interface is too fat — that pain is the
  design feedback, fix the interface.

## Faking pattern

```ts
import { FakePricingAdapter } from "@/adapters/fakes";

const pricing = new FakePricingAdapter();
pricing.setListings("Miles Davis", "Kind of Blue", [
  { source: "discogs", listingUrl: "https://discogs/x", landedPricePence: 2200, available: true },
  { source: "amazon", listingUrl: "https://amazon/y", landedPricePence: 2500, available: true },
]);

// Inject `pricing` where the real PricingAdapter would go, then assert on the seam:
// the cheaper landed cost (Discogs, £22) is chosen — never on network or prose.

// Staleness (ADR-0003):
pricing.markGone("https://discogs/x");            // listing vanished
pricing.setDriftedPrice("https://amazon/y", 2900); // price drifted +£4 over quote
```

## Implementations

| Interface             | Real implementation                       | Status                                  |
| --------------------- | ----------------------------------------- | --------------------------------------- |
| `DiscogsAdapter`      | `HttpDiscogsAdapter` (`discogs.ts`)       | Shipped (issue #3)                      |
| `PricingAdapter`      | `HttpPricingAdapter` (`pricing.ts`)       | Shipped (issue #6)                      |
| `NotificationAdapter` | `WindowsToastNotificationAdapter` (`notify.ts`) | Shipped (issue #7)                |
| `BuyAdapter`          | —                                         | Lifecycle drives a fake (#7); real Playwright in #9 |

### Discogs (`HttpDiscogsAdapter`)

Reads Euan's collection from the Discogs API (`/users/{username}/collection/folders/0/releases`),
paginated, and maps each owned copy to a `DiscogsCollectionItem` (artist, title, year,
release/instance ids, genres, styles).

- **Auth / OAuth scope.** Single-user local app (ADR-0001), so it uses a Discogs
  **personal access token** instead of the 3-legged OAuth flow. The token is scoped to the
  owner's own account — exactly what listing _your_ collection needs, and **no write scope**
  (collection write-back on arrival is issue #10). Sent as `Authorization: Discogs token=…`.
  Config via `DISCOGS_USERNAME` / `DISCOGS_TOKEN` (see `.env.example`); build with
  `discogsAdapterFromEnv()`, which returns `null` when unset so callers degrade gracefully.
- **Rate limits.** Discogs allows ~60 authenticated requests/min and reports budget in
  `X-Discogs-Ratelimit-*` headers. The adapter pauses before the next page when the
  remaining budget is low and backs off + retries on HTTP 429 (capped by `maxRetries`).
- **Testing.** The `DiscogsAdapter` _interface_ is faked via `FakeDiscogsAdapter` for the
  sync-service tests. `HttpDiscogsAdapter`'s own pagination/rate-limit logic is tested
  separately with an injected `fetch` + `sleep` (`discogs.test.ts`) — still no live calls.

### Cross-source pricing (`HttpPricingAdapter`)

Looks a chosen record up on **both** Discogs Marketplace and Amazon and reports **landed cost**
(item + shipping, GBP) per source, so the picker buys from the cheaper landed cost (price is a
_source-selector_, never a record-selector — CONTEXT.md). Shape: a composite over per-source
`PriceSource`s.

- **Composite (`HttpPricingAdapter`).** Fans `lookup` across every source and returns each
  source's cheapest available listing; a source that throws is skipped so one being down never
  hides the other. `revalidate` is routed to whichever source owns the listing URL, and a thrown
  re-check becomes `null` so the order lifecycle marks it STALE rather than buying blind.
- **Discogs (`DiscogsMarketplaceSource`).** `lookup` resolves the release via the official
  search API, then parses the public marketplace **sell page** for the cheapest listing (item +
  per-seller shipping + condition) — Discogs has no API that enumerates a release's listings.
  `revalidate` uses the robust official **single-listing** endpoint (`/marketplace/listings/{id}`),
  treating 404/sold as gone.
- **Amazon (`AmazonSource`).** No free product API, so both calls parse HTML (search → first
  ASIN + GBP price; product → price + in-stock). Repressings ship Prime/free → landed == item.
- **Brittleness is contained.** The HTML parsers (`parseDiscogsSellPage`, `parseAmazonSearch`,
  `parseAmazonProduct`) are small pure functions tested against fixtures; a markup change is a
  localized fix. Transport is an injected `fetch`, so it can later be swapped for a
  Playwright-backed fetch (ADR-0003's real Chrome) without touching parsing or the picker.
- **Config.** `DISCOGS_TOKEN` (optional — lifts search rate limits) + `AMAZON_BASE_URL` (locale).
  Build with `pricingAdapterFromEnv()`; both sources have public defaults so it never returns null.

### Notifications (`WindowsToastNotificationAdapter`)

The "a record is on its way — approve £X at \<source\>" desktop nudge auto-prep raises when an
order reaches PROPOSED (issue #7). **Title-hiding by design** (CONTEXT.md → Two-phase buy): the
`ProposedNotification` payload carries price + source only, never the record title, so the
surprise survives until the arrival Reveal.

- **Windows toast (`WindowsToastNotificationAdapter`).** Raises a native WinRT toast via a
  one-shot PowerShell call — no npm dependency. Works from a headless scheduled Run because the
  toast surfaces in Euan's logged-in session.
- **Degrades, never throws.** By the time we notify, a valid PROPOSED Quote is already parked; a
  notification failure must not undo a completed auto-prep, so the toast swallows its own errors
  and falls back to a console line. `ConsoleNotificationAdapter` is the always-works fallback on
  non-Windows platforms.
- **Config.** `notificationAdapterFromEnv()` picks the Windows toast on `win32`, else the console
  adapter. Tests inject `FakeNotificationAdapter` and read back `.sent`.

The remaining `BuyAdapter` implementation (the real Playwright finalize + Decline) lands in
issue #9; issue #7 drives the order lifecycle against `FakeBuyAdapter`. This convention keeps
every external dependency behind a thin, fakeable seam.
