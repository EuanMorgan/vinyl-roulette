/**
 * Tests for the real `BuyAdapter` (issue #9). The browser is the seam: a `FakeBuyPage` records
 * every click/wait and returns canned confirmation text, so the orchestration (open fresh →
 * drive to button → hold → finalize → always close) and the per-source checkout flows are
 * exercised with no Chrome and no network — the same faking convention `pricing.ts` uses for
 * `fetch`. The brittle real selectors are pinned here so a rename breaks a test.
 */
import { describe, it, expect } from "vitest";
import type { BuyQuote } from "./types";
import {
  PlaywrightBuyAdapter,
  amazonCheckoutFlow,
  discogsCheckoutFlow,
  type BuyBrowser,
  type BuyPage,
  type CheckoutFlow,
} from "./buy";

/** A fake page: records actions, fails configured selectors, serves canned text. */
class FakeBuyPage implements BuyPage {
  readonly clicks: string[] = [];
  readonly waits: string[] = [];
  closed = 0;
  private text = new Map<string, string>();
  /** Selectors that should throw when clicked/waited (e.g. "checkout markup changed"). */
  failOn = new Set<string>();

  constructor(private currentUrl = "https://example/listing") {}

  setText(selector: string, value: string): this {
    this.text.set(selector, value);
    return this;
  }

  url(): string {
    return this.currentUrl;
  }
  async click(selector: string): Promise<void> {
    if (this.failOn.has(selector)) throw new Error(`cannot click ${selector}`);
    this.clicks.push(selector);
  }
  async waitForVisible(selector: string): Promise<void> {
    if (this.failOn.has(selector)) throw new Error(`never saw ${selector}`);
    this.waits.push(selector);
  }
  async textContent(selector: string): Promise<string | null> {
    return this.text.get(selector) ?? null;
  }
  async close(): Promise<void> {
    this.closed += 1;
  }
}

/** A fake browser handing out a pre-built page and recording what URL it was asked to open. */
class FakeBuyBrowser implements BuyBrowser {
  readonly opened: string[] = [];
  /** Set to make `open` itself throw (browser/profile launch failure). */
  openError?: string;
  constructor(private readonly page: BuyPage) {}
  async open(url: string): Promise<BuyPage> {
    if (this.openError) throw new Error(this.openError);
    this.opened.push(url);
    return this.page;
  }
}

/** A flow that records calls and can be told to throw — for testing routing + error paths. */
class RecordingFlow implements CheckoutFlow {
  readonly calls: string[] = [];
  driveError?: string;
  finalizeError?: string;
  constructor(
    readonly source: "discogs" | "amazon",
    private readonly result: { reference?: string; finalPricePence?: number } = {},
  ) {}
  async driveToPayment(): Promise<void> {
    this.calls.push("drive");
    if (this.driveError) throw new Error(this.driveError);
  }
  async finalize(): Promise<{ reference?: string; finalPricePence?: number }> {
    this.calls.push("finalize");
    if (this.finalizeError) throw new Error(this.finalizeError);
    return this.result;
  }
}

const QUOTE: BuyQuote = {
  source: "discogs",
  listingUrl: "https://discogs.example/sell/item/123",
  expectedPricePence: 2650,
};

describe("PlaywrightBuyAdapter orchestration", () => {
  it("opens fresh, drives to the button on prepare, finalizes + closes on pay", async () => {
    const page = new FakeBuyPage();
    const browser = new FakeBuyBrowser(page);
    const flow = new RecordingFlow("discogs", { reference: "ORD-1", finalPricePence: 2700 });
    const adapter = new PlaywrightBuyAdapter(browser, { discogs: flow, amazon: flow });

    const prep = await adapter.prepare(QUOTE);
    expect(prep.ready).toBe(true);
    expect(browser.opened).toEqual([QUOTE.listingUrl]); // re-opened fresh at the listing
    expect(flow.calls).toEqual(["drive"]); // drove to the button, did NOT finalize yet
    expect(page.closed).toBe(0); // held open for the human to clear the challenge

    const result = await adapter.pay(QUOTE);
    expect(result).toMatchObject({ ok: true, reference: "ORD-1", finalPricePence: 2700 });
    expect(flow.calls).toEqual(["drive", "finalize"]);
    expect(page.closed).toBe(1); // page always closed after pay
  });

  it("routes to the checkout flow matching the quote's source", async () => {
    const page = new FakeBuyPage();
    const discogs = new RecordingFlow("discogs");
    const amazon = new RecordingFlow("amazon");
    const adapter = new PlaywrightBuyAdapter(new FakeBuyBrowser(page), { discogs, amazon });

    await adapter.prepare({ ...QUOTE, source: "amazon", listingUrl: "https://amazon.example/dp/X" });
    expect(amazon.calls).toEqual(["drive"]);
    expect(discogs.calls).toEqual([]);
  });

  it("falls back to the quoted price when the confirmation has no total", async () => {
    const flow = new RecordingFlow("discogs", { reference: "ORD-2" }); // no finalPricePence
    const adapter = new PlaywrightBuyAdapter(new FakeBuyBrowser(new FakeBuyPage()), {
      discogs: flow,
      amazon: flow,
    });
    await adapter.prepare(QUOTE);
    const result = await adapter.pay(QUOTE);
    expect(result.finalPricePence).toBe(QUOTE.expectedPricePence);
  });

  it("returns not-ready and closes the page when drive-to-button fails", async () => {
    const page = new FakeBuyPage();
    const flow = new RecordingFlow("discogs");
    flow.driveError = "checkout markup changed";
    const adapter = new PlaywrightBuyAdapter(new FakeBuyBrowser(page), { discogs: flow, amazon: flow });

    const prep = await adapter.prepare(QUOTE);
    expect(prep.ready).toBe(false);
    expect(prep.error).toContain("checkout markup changed");
    expect(page.closed).toBe(1); // no leaked browser session on a failed prepare
    // Nothing is held: a subsequent pay has no prepared page.
    const result = await adapter.pay(QUOTE);
    expect(result.ok).toBe(false);
  });

  it("returns not-ready when the browser/profile can't be launched", async () => {
    const browser = new FakeBuyBrowser(new FakeBuyPage());
    browser.openError = "chrome profile is locked (already open)";
    const adapter = new PlaywrightBuyAdapter(browser, {
      discogs: new RecordingFlow("discogs"),
      amazon: new RecordingFlow("amazon"),
    });
    const prep = await adapter.prepare(QUOTE);
    expect(prep.ready).toBe(false);
    expect(prep.error).toContain("locked");
  });

  it("surfaces a finalize failure as ok:false and still closes the page", async () => {
    const page = new FakeBuyPage();
    const flow = new RecordingFlow("discogs");
    flow.finalizeError = "browser crashed mid-checkout";
    const adapter = new PlaywrightBuyAdapter(new FakeBuyBrowser(page), { discogs: flow, amazon: flow });

    await adapter.prepare(QUOTE);
    const result = await adapter.pay(QUOTE);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("browser crashed");
    expect(page.closed).toBe(1);
  });

  it("refuses to pay when prepare was never called (no cold checkout)", async () => {
    const adapter = new PlaywrightBuyAdapter(new FakeBuyBrowser(new FakeBuyPage()), {
      discogs: new RecordingFlow("discogs"),
      amazon: new RecordingFlow("amazon"),
    });
    const result = await adapter.pay(QUOTE);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not prepared");
  });

  it("re-preparing the same listing closes the earlier held page (no leak)", async () => {
    const first = new FakeBuyPage();
    const second = new FakeBuyPage();
    let n = 0;
    const browser: BuyBrowser = { async open() { return n++ === 0 ? first : second; } };
    const flow = new RecordingFlow("discogs");
    const adapter = new PlaywrightBuyAdapter(browser, { discogs: flow, amazon: flow });

    await adapter.prepare(QUOTE);
    await adapter.prepare(QUOTE); // a retried approval
    expect(first.closed).toBe(1); // the stale page was discarded
    expect(second.closed).toBe(0); // the new one is held
  });
});

describe("checkout flows drive the documented selectors", () => {
  it("discogs: adds to cart, proceeds to checkout, waits at the pay button; finalize pays + reads", async () => {
    const page = new FakeBuyPage()
      .setText(".order-confirmation .order-number, [data-order-id]", " D-99 ")
      .setText(".order-confirmation .total, .order-total", "£26.50");

    await discogsCheckoutFlow.driveToPayment(page);
    // Drove through the cart to the pay button, but stopped *at* it (waited, never clicked it).
    expect(page.clicks).toHaveLength(2);
    expect(page.waits).toHaveLength(1);
    const beforeFinalize = [...page.clicks];

    const out = await discogsCheckoutFlow.finalize(page);
    expect(page.clicks.length).toBe(beforeFinalize.length + 1); // the pay click
    expect(out).toEqual({ reference: "D-99", finalPricePence: 2650 });
  });

  it("amazon: buy-now then waits for place-order; finalize places the order + reads total", async () => {
    const page = new FakeBuyPage().setText("#od-subtotals .a-color-price, #order-total", "£24.00");

    await amazonCheckoutFlow.driveToPayment(page);
    expect(page.clicks).toHaveLength(1); // buy-now
    expect(page.waits).toHaveLength(1); // place-order visible

    const out = await amazonCheckoutFlow.finalize(page);
    expect(out.finalPricePence).toBe(2400);
  });
});
