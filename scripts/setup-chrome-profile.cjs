// One-time setup: open the dedicated automation Chrome profile so Euan can log into Amazon.
//
// Why this exists: Chrome (M136+) refuses DevTools remote debugging when --user-data-dir is the
// DEFAULT profile dir, so Playwright hangs on about:blank. The buy must use a NON-DEFAULT profile.
// This launches that profile headed, lands on Amazon sign-in, and stays open until you close the
// window. Log in (and to PayPal if you use it), then just close Chrome — the script exits.
//
// Run:  node scripts/setup-chrome-profile.cjs  [optional path; defaults to PROFILE_DIR below]
const { chromium } = require("playwright-core");

const PROFILE_DIR =
  process.argv[2] || process.env.VINYL_CHROME_PROFILE || "C:\\Users\\euanm\\dev\\vinyl-autobuy-chrome";
const channel = process.env.CHROME_CHANNEL || "chrome";

(async () => {
  console.log("profile dir:", JSON.stringify(PROFILE_DIR));
  console.log("channel    :", channel);
  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, { channel, headless: false });
  } catch (e) {
    console.log("LAUNCH ERROR:", e.message);
    process.exit(1);
  }
  console.log("launched OK. Driving to Amazon sign-in...");
  const page = context.pages()[0] || (await context.newPage());
  try {
    await page.goto("https://www.amazon.co.uk/ap/signin", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    console.log("On:", page.url());
  } catch (e) {
    console.log("(navigation note:", e.message, ") — you can browse to Amazon manually.");
  }
  console.log(">>> Log into Amazon in this window, then CLOSE the window when done. <<<");
  // Exit when Euan closes the browser, so the lock is released cleanly.
  await new Promise((resolve) => context.on("close", resolve));
  console.log("Browser closed — profile saved at", PROFILE_DIR);
})();
