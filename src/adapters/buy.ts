/**
 * The real `BuyAdapter` (issue #9) behind the seam from #7 — the Hands of the two-phase buy.
 *
 * The order lifecycle (`approveOrder`, lifecycle.ts) consumes only the `BuyAdapter` interface
 * and is **unchanged** by this file: it re-validates a listing, then calls `prepare` (drive to
 * the payment button) and `pay` (finalize). This slice swaps the fake (`FakeBuyAdapter`) for
 * real Playwright driving **Euan's real Chrome profile** (ADR-0003), so the buy reuses his
 * logged-in Amazon/Discogs/PayPal sessions and the human is on hand to clear the payment
 * challenge a bot can't.
 *
 * ## The human-in-the-loop split (ADR-0003 — do not re-introduce unattended payment)
 * Both calls run at APPROVAL time, fresh (auto-prep holds *no* live cart — CONTEXT.md → Quote):
 *   - `prepare` re-opens the re-validated listing and drives source-specific checkout up to —
 *     **but not through** — the payment button, then leaves the page open.
 *   - Euan clears any 2FA / PayPal / CVV challenge himself in that open window.
 *   - `pay` clicks the final control and reads the confirmation back.
 * The open page is held between the two calls so the human gap is real, not simulated.
 *
 * ## Shape: an orchestrator over an injectable browser + per-source checkout flows
 * `PlaywrightBuyAdapter` owns no Playwright and no selectors. It opens a page via an injected
 * `BuyBrowser`, dispatches to a `CheckoutFlow` chosen by the quote's source, holds the open
 * page across `prepare`→`pay`, and always closes it afterwards. All the brittle, markup-bound
 * knowledge lives in the per-source `CheckoutFlow`s — exactly the stance `pricing.ts` takes with
 * its HTML parsers: isolated, fixture/fake-tested, and a localized fix when a site changes. The
 * browser is injected (like `pricing.ts`'s `fetch`), so the orchestration is tested with a fake
 * page and never launches Chrome.
 */
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Source } from "@/store/types";
import type { BuyAdapter, BuyQuote, BuyResult } from "./types";
import { parseGbpToPence } from "./pricing";

// ── Browser seam (injected; faked in tests) ─────────────────────────────────────────

/** The slice of a browser page the checkout flows drive — kept narrow so a fake is trivial. */
export interface BuyPage {
  /** The page's current URL (after any checkout redirects). */
  url(): string;
  /** Click a control, waiting for it to be actionable. Throws if it never appears. */
  click(selector: string, opts?: { timeoutMs?: number }): Promise<void>;
  /** Wait for an element to be visible — used to confirm we reached a step. Throws on timeout. */
  waitForVisible(selector: string, opts?: { timeoutMs?: number }): Promise<void>;
  /** Read an element's text (e.g. an order total / reference), or null if absent. */
  textContent(selector: string): Promise<string | null>;
  /** Wait until the URL matches `pattern` (a regex source string or RegExp). Throws on timeout. */
  waitForUrl(pattern: string | RegExp, opts?: { timeoutMs?: number }): Promise<void>;
  /** Best-effort debug screenshot, returning the saved path (or null if it couldn't be taken). */
  screenshot(label: string): Promise<string | null>;
  /** Close the page and its underlying browser context (releases the Chrome profile). */
  close(): Promise<void>;
}

/** Opens Euan's real Chrome profile and navigates fresh to a listing (ADR-0003). */
export interface BuyBrowser {
  /** Launch the profile and navigate a fresh page to `url`. */
  open(url: string): Promise<BuyPage>;
}

// ── Per-source checkout flows (the brittle, markup-bound part — isolated by design) ───

/** Drives one source's checkout: to the payment button (`driveToPayment`), then through it. */
export interface CheckoutFlow {
  readonly source: Source;
  /** Drive the open listing page up to — not through — the payment button. Throws if it can't. */
  driveToPayment(page: BuyPage): Promise<void>;
  /** Click the final pay control and read the confirmation back. Throws if payment didn't land. */
  finalize(page: BuyPage): Promise<{ reference?: string; finalPricePence?: number }>;
}

/**
 * Selectors target each site's *current* public checkout markup and are the brittle, maintenance-
 * prone part by design (cf. `pricing.ts`'s HTML parsers). They're collected here so a markup
 * change is a one-line edit, and pinned by `buy.test.ts` against a fake page so a rename is caught.
 */
const DISCOGS_SELECTORS = {
  /** "Add to Cart" on a marketplace item page. */
  addToCart: "button.buy_release_button, #buy_release_button, button[data-action='add-to-cart']",
  /** "Checkout with PayPal" / proceed-to-payment on the cart page. */
  checkout: "button.payment_button, a.button_with_count, button[name='checkout']",
  /** The final pay control once the order is reviewed (PayPal's review page). */
  payButton: "#payment-submit-btn, button[data-testid='submit-button-initial']",
  /** Order-confirmation markers, read after `payButton` is clicked. */
  confirmation: ".order-confirmation, [data-testid='order-confirmation']",
  orderReference: ".order-confirmation .order-number, [data-order-id]",
  orderTotal: ".order-confirmation .total, .order-total",
} as const;

const AMAZON_SELECTORS = {
  /** "Buy Now" on a product page (skips the cart into turbo-checkout). */
  buyNow: "#buy-now-button, input[name='submit.buy-now']",
  /** "Place your order" — present once buy-now's checkout pane has loaded. */
  placeOrder: "#turbo-checkout-pyo-button, input[name='placeYourOrder1'], #placeYourOrder",
  /** Confirmation-page DOM markers, read after the order is placed. */
  confirmation: "#widget-purchaseConfirmationStatus, [data-testid='order-confirmation']",
  /**
   * Amazon completes an order by navigating to a thank-you URL. This is the *reliable* success
   * signal — the confirmation DOM above is heavily A/B-tested and a missed selector once recorded a
   * truly-placed order as FAILED. `finalize` treats EITHER this URL OR the DOM marker as success.
   */
  confirmationUrlPattern: "thankyou|/buy/spc|order-?confirmation|/gp/buy/",
  orderReference: "#widget-purchaseConfirmationStatus [dir='ltr'], .order-number",
  orderTotal: "#od-subtotals .a-color-price, #order-total",
} as const;

/** Generous default — the human may be clearing 2FA/PayPal between steps. */
const DEFAULT_STEP_TIMEOUT_MS = 120_000;

export const discogsCheckoutFlow: CheckoutFlow = {
  source: "discogs",
  async driveToPayment(page) {
    await page.click(DISCOGS_SELECTORS.addToCart);
    await page.click(DISCOGS_SELECTORS.checkout);
    // Reaching (not clicking) the pay control proves we drove to the payment button.
    await page.waitForVisible(DISCOGS_SELECTORS.payButton);
  },
  async finalize(page) {
    await page.click(DISCOGS_SELECTORS.payButton);
    await page.waitForVisible(DISCOGS_SELECTORS.confirmation);
    return readConfirmation(page, DISCOGS_SELECTORS);
  },
};

export const amazonCheckoutFlow: CheckoutFlow = {
  source: "amazon",
  async driveToPayment(page) {
    await page.click(AMAZON_SELECTORS.buyNow);
    await page.waitForVisible(AMAZON_SELECTORS.placeOrder);
  },
  async finalize(page) {
    // Clicking "Place your order" submits and navigates to the thank-you page. That navigation can
    // reject the click promise ("Execution context was destroyed, most likely because of a
    // navigation") even though the order WAS placed — which previously recorded a real, paid-for
    // order as FAILED. So the click resolving cleanly is NOT the success signal; reaching a
    // confirmed-order state is. Swallow the navigation-race rejection and let `confirmAmazonOrder`
    // be the sole source of truth (it fails loudly, with a screenshot, if the order didn't land).
    await page.click(AMAZON_SELECTORS.placeOrder).catch(() => {});
    await confirmAmazonOrder(page);
    return readConfirmation(page, AMAZON_SELECTORS);
  },
};

/**
 * Confirm an Amazon order actually went through, by EITHER signal: a navigation to a thank-you URL
 * (regular checkout) OR the confirmation DOM marker (turbo Buy-Now, which updates in place without
 * navigating). Whichever fires first wins. If neither does, capture a screenshot + the current URL
 * and fail loudly — an unconfirmed order must never be recorded ORDERED, but the diagnostics turn a
 * still-wrong selector into a one-line fix instead of another blind guess (#22).
 */
async function confirmAmazonOrder(page: BuyPage): Promise<void> {
  try {
    await Promise.any([
      page.waitForUrl(AMAZON_SELECTORS.confirmationUrlPattern),
      page.waitForVisible(AMAZON_SELECTORS.confirmation),
    ]);
  } catch {
    const shot = await page.screenshot("amazon-confirmation-miss").catch(() => null);
    throw new Error(
      `order confirmation not detected after Place Order (url=${page.url()}` +
        `${shot ? `, screenshot=${shot}` : ""})`,
    );
  }
}

/** Read the order reference + total off a confirmation page; both are best-effort (may be absent). */
async function readConfirmation(
  page: BuyPage,
  sel: { orderReference: string; orderTotal: string },
): Promise<{ reference?: string; finalPricePence?: number }> {
  const reference = (await page.textContent(sel.orderReference))?.trim() || undefined;
  const finalPricePence = parseGbpToPence(await page.textContent(sel.orderTotal)) ?? undefined;
  return { reference, finalPricePence };
}

export const DEFAULT_CHECKOUT_FLOWS: Record<Source, CheckoutFlow> = {
  discogs: discogsCheckoutFlow,
  amazon: amazonCheckoutFlow,
};

// ── The orchestrator ────────────────────────────────────────────────────────────────

/**
 * The real `BuyAdapter`: opens the listing fresh, drives the source's checkout to the payment
 * button (`prepare`), then finalizes (`pay`) after the human has cleared the payment challenge.
 * The open page is held between the two calls (keyed by listing URL) so the human-in-the-loop
 * gap is genuine; it is always closed afterwards — including on any failure — so a crashed buy
 * never leaks a Chrome session holding the profile lock.
 */
export class PlaywrightBuyAdapter implements BuyAdapter {
  private readonly pending = new Map<string, { page: BuyPage; flow: CheckoutFlow }>();

  constructor(
    private readonly browser: BuyBrowser,
    private readonly flows: Record<Source, CheckoutFlow> = DEFAULT_CHECKOUT_FLOWS,
  ) {}

  /** Re-open the listing fresh and drive the source's checkout to the payment button. */
  async prepare(quote: BuyQuote): Promise<{ ready: boolean; error?: string }> {
    // A re-prepare for the same listing (e.g. a retried approval) must not leak the earlier page.
    await this.discard(quote.listingUrl);

    const flow = this.flows[quote.source];
    let page: BuyPage;
    try {
      page = await this.browser.open(quote.listingUrl);
    } catch (err) {
      return { ready: false, error: errorMessage(err) };
    }

    try {
      await flow.driveToPayment(page);
    } catch (err) {
      await safeClose(page);
      return { ready: false, error: errorMessage(err) };
    }

    // Held open for the human to clear 2FA/PayPal/CVV; `pay` finalizes against this same page.
    this.pending.set(quote.listingUrl, { page, flow });
    return { ready: true };
  }

  /** Finalize payment against the page `prepare` left at the payment button, then close it. */
  async pay(quote: BuyQuote): Promise<BuyResult> {
    const held = this.pending.get(quote.listingUrl);
    if (!held) {
      // pay without a prepared page: refuse rather than re-driving checkout from cold.
      return { ok: false, error: "checkout was not prepared (call prepare first)" };
    }
    this.pending.delete(quote.listingUrl);
    try {
      const { reference, finalPricePence } = await held.flow.finalize(held.page);
      return { ok: true, reference, finalPricePence: finalPricePence ?? quote.expectedPricePence };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    } finally {
      await safeClose(held.page);
    }
  }

  /** Close + forget any page held for a listing (used before a re-prepare). */
  private async discard(listingUrl: string): Promise<void> {
    const held = this.pending.get(listingUrl);
    if (!held) return;
    this.pending.delete(listingUrl);
    await safeClose(held.page);
  }
}

/** Close a page without ever throwing — cleanup must not mask the real prepare/pay outcome. */
async function safeClose(page: BuyPage): Promise<void> {
  try {
    await page.close();
  } catch (err) {
    console.warn("[buy] failed to close checkout page:", errorMessage(err));
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Real Playwright browser (Euan's Chrome profile) ──────────────────────────────────

/** Minimal structural views of the playwright-core objects we touch — keeps the import lazy. */
interface PwPage {
  url(): string;
  goto(url: string, opts?: { timeout?: number; waitUntil?: string }): Promise<unknown>;
  click(selector: string, opts?: { timeout?: number }): Promise<void>;
  waitForSelector(selector: string, opts?: { state?: string; timeout?: number }): Promise<unknown>;
  waitForURL(url: string | RegExp, opts?: { timeout?: number }): Promise<void>;
  textContent(selector: string, opts?: { timeout?: number }): Promise<string | null>;
  screenshot(opts: { path?: string; fullPage?: boolean }): Promise<unknown>;
  bringToFront?(): Promise<void>;
}
interface PwContext {
  pages(): PwPage[];
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}

export interface PlaywrightBuyBrowserConfig {
  /** Path to Euan's real Chrome user-data dir (reuses logged-in sessions — ADR-0003). */
  userDataDir: string;
  /** Browser channel to launch (default "chrome" — the installed system Chrome, not a download). */
  channel?: string;
  /** Per-step timeout in ms; generous so the human can clear a payment challenge. */
  stepTimeoutMs?: number;
  /**
   * Run headless. Defaults to *headed* (false): the buy needs the human to clear 2FA/PayPal/CVV,
   * and watching it is reassuring for the first orders. Flip on later for a hands-off cadence.
   */
  headless?: boolean;
  /**
   * Before launching, force-quit any running Chrome so Playwright can take the profile lock
   * (a running Chrome holds it, and the launch degrades to a blank window that never navigates).
   * Default true on Windows — the local deploy target (ADR-0003). Injectable for tests.
   */
  forceCloseChrome?: boolean;
  /** The profile-lock release step (kill Chrome + wait). Injected so tests never touch the OS. */
  releaseProfileLock?: () => Promise<void>;
}

/**
 * The real `BuyBrowser`: launches the system Chrome against Euan's profile via playwright-core's
 * persistent context, so logged-in Amazon/Discogs/PayPal sessions are reused. Headed by
 * necessity — the human clears the payment challenge. `playwright-core` is imported lazily so the
 * UI/agent code paths that never buy don't pay for it, and so tests stay browser-free.
 */
export class PlaywrightBuyBrowser implements BuyBrowser {
  constructor(private readonly config: PlaywrightBuyBrowserConfig) {}

  async open(url: string): Promise<BuyPage> {
    // Chrome (M136+) refuses DevTools remote debugging on the DEFAULT profile dir, so Playwright's
    // CDP handshake never completes and the launch hangs on about:blank for the full timeout. Catch
    // it here with an actionable message instead of a silent 3-minute stall (see ADR-0003 / #21).
    assertNonDefaultProfile(this.config.userDataDir);

    // A running Chrome holds the profile lock; Playwright then launches a blank window that never
    // navigates (the about:blank wedge). Force-close it first so the buy can take the profile.
    const forceClose = this.config.forceCloseChrome ?? process.platform === "win32";
    if (forceClose) {
      await (this.config.releaseProfileLock ?? killRunningChrome)();
    }

    const { chromium } = (await import("playwright-core")) as {
      chromium: {
        launchPersistentContext(
          userDataDir: string,
          opts: { channel?: string; headless?: boolean },
        ): Promise<PwContext>;
      };
    };
    const context = await chromium.launchPersistentContext(this.config.userDataDir, {
      channel: this.config.channel ?? "chrome",
      headless: this.config.headless ?? false, // headed by default: the human clears 2FA/PayPal/CVV
    });
    const stepTimeoutMs = this.config.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    try {
      // Drive a dedicated fresh page (not a restored session tab, which may be about:blank), and
      // surface it so the human sees the checkout they're clearing.
      const page = await context.newPage();
      await page.bringToFront?.();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: stepTimeoutMs });
      return new PlaywrightBuyPage(context, page, stepTimeoutMs);
    } catch (err) {
      await context.close().catch(() => {});
      throw err;
    }
  }
}

/**
 * Chrome refuses DevTools remote debugging when `--user-data-dir` is the *default* profile dir
 * (a M136+ anti-CDP-attack measure), so Playwright hangs on about:blank until timeout. The buy
 * must use a dedicated, non-default profile (`scripts/setup-chrome-profile.cjs`). Fail fast and
 * loud here rather than letting `prepare` stall for the full step timeout.
 */
export function assertNonDefaultProfile(userDataDir: string): void {
  // Match the OS-default Chrome user-data roots; the trailing "User Data" segment is the tell.
  const normalized = userDataDir.replace(/[\\/]+$/, "").toLowerCase();
  const isDefault =
    /[\\/]google[\\/]chrome[\\/]user data$/.test(normalized) || // Windows
    /[\\/]google[\\/]chrome$/.test(normalized) || // macOS (~/Library/Application Support/Google/Chrome)
    /[\\/]google-chrome$/.test(normalized); // Linux (~/.config/google-chrome)
  if (isDefault) {
    throw new Error(
      `CHROME_USER_DATA_DIR points at Chrome's DEFAULT profile (${userDataDir}). Chrome blocks ` +
        `remote debugging there, so the buy would hang on about:blank. Use a dedicated profile: ` +
        `run \`node scripts/setup-chrome-profile.cjs\` and set CHROME_USER_DATA_DIR to that dir.`,
    );
  }
}

/**
 * Force-quit any running Chrome so Playwright can take the profile lock (Windows deploy target,
 * ADR-0003). Best-effort: `taskkill` exits non-zero when no Chrome is running, which is fine — we
 * just need the lock free. A short pause lets Windows release the profile's lock file before launch.
 * Scoped to `chrome.exe`, so it never touches Arc (the daily driver) or other Chromium browsers.
 */
function killRunningChrome(): Promise<void> {
  if (process.platform !== "win32") return Promise.resolve();
  return new Promise((resolve) => {
    execFile("taskkill", ["/F", "/IM", "chrome.exe", "/T"], () => {
      // Ignore the result (non-zero = nothing to kill). Give the lock file a moment to release.
      setTimeout(resolve, 1500).unref?.();
    });
  });
}

/** Wraps a playwright-core page/context behind the narrow `BuyPage` seam. */
class PlaywrightBuyPage implements BuyPage {
  constructor(
    private readonly context: PwContext,
    private readonly page: PwPage,
    private readonly stepTimeoutMs: number,
  ) {}

  url(): string {
    return this.page.url();
  }
  async click(selector: string, opts?: { timeoutMs?: number }): Promise<void> {
    await this.page.click(selector, { timeout: opts?.timeoutMs ?? this.stepTimeoutMs });
  }
  async waitForVisible(selector: string, opts?: { timeoutMs?: number }): Promise<void> {
    await this.page.waitForSelector(selector, {
      state: "visible",
      timeout: opts?.timeoutMs ?? this.stepTimeoutMs,
    });
  }
  async textContent(selector: string): Promise<string | null> {
    // Best-effort by contract (`BuyPage.textContent` → "or null if absent"). Playwright's
    // page.textContent AUTO-WAITS and THROWS when the selector never appears — which once failed a
    // fully-placed, confirmed order just because the optional order-reference markup didn't match.
    // A short timeout + null-on-miss keeps these reads truly optional metadata, never a buy-killer.
    return this.page.textContent(selector, { timeout: 2_000 }).catch(() => null);
  }
  async waitForUrl(pattern: string | RegExp, opts?: { timeoutMs?: number }): Promise<void> {
    const re = typeof pattern === "string" ? new RegExp(pattern) : pattern;
    await this.page.waitForURL(re, { timeout: opts?.timeoutMs ?? this.stepTimeoutMs });
  }
  async screenshot(label: string): Promise<string | null> {
    try {
      const dir = join(process.cwd(), ".buy-debug");
      await mkdir(dir, { recursive: true });
      const path = join(dir, `${label}-${Date.now()}.png`);
      await this.page.screenshot({ path, fullPage: true });
      return path;
    } catch {
      return null;
    }
  }
  async close(): Promise<void> {
    await this.context.close();
  }
}

/**
 * Build the production buy adapter from environment config, or return null if the real Chrome
 * profile isn't configured (so callers degrade rather than crash). `CHROME_USER_DATA_DIR` must
 * point at Euan's real profile dir; `CHROME_CHANNEL` overrides the default "chrome" channel.
 */
export function buyAdapterFromEnv(env: NodeJS.ProcessEnv = process.env): PlaywrightBuyAdapter | null {
  const userDataDir = env.CHROME_USER_DATA_DIR?.trim();
  if (!userDataDir) return null;
  const browser = new PlaywrightBuyBrowser({
    userDataDir,
    channel: env.CHROME_CHANNEL?.trim() || undefined,
    // Watch the buy by default; set CHROME_HEADLESS=1 once you trust the cadence.
    headless: env.CHROME_HEADLESS?.trim() === "1",
  });
  return new PlaywrightBuyAdapter(browser);
}
