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

The real `DiscogsAdapter`, `PricingAdapter`, and `BuyAdapter` implementations land in
their own later slices. This slice ships only the contracts and the fakes.
