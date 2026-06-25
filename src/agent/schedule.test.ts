/**
 * The monthly catch-up guard (issue #11), the testable core of "a missed monthly trigger runs
 * at next boot". `monthlyRunDue` answers a single question — given when the last *scheduled* Run
 * started, is this period's Run still owed? — so both the monthly Task Scheduler trigger and the
 * AtStartup boot trigger can call the same entrypoint with `--if-due` and stay idempotent: the
 * monthly trigger fires the Run; a boot the next day skips it; a boot after a month-off catches up.
 */
import { describe, it, expect } from "vitest";
import { monthlyRunDue, MONTHLY_RUN_INTERVAL_DAYS } from "./schedule";

const NOW = new Date("2026-06-25T09:00:00.000Z");
const daysBefore = (n: number): string =>
  new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

describe("monthlyRunDue", () => {
  it("is due when no scheduled Run has ever happened", () => {
    expect(monthlyRunDue(null, NOW)).toBe(true);
  });

  it("is not due right after a scheduled Run (boot trigger the next day skips)", () => {
    expect(monthlyRunDue(daysBefore(1), NOW)).toBe(false);
  });

  it("is due once a full interval has elapsed (machine was off → catch up at boot)", () => {
    expect(monthlyRunDue(daysBefore(MONTHLY_RUN_INTERVAL_DAYS + 1), NOW)).toBe(true);
  });

  it("treats exactly the interval boundary as due", () => {
    expect(monthlyRunDue(daysBefore(MONTHLY_RUN_INTERVAL_DAYS), NOW)).toBe(true);
  });

  it("honours a custom interval", () => {
    expect(monthlyRunDue(daysBefore(5), NOW, 7)).toBe(false);
    expect(monthlyRunDue(daysBefore(8), NOW, 7)).toBe(true);
  });

  it("treats an unparseable timestamp as never-run (fail open → run rather than silently skip)", () => {
    expect(monthlyRunDue("not-a-date", NOW)).toBe(true);
  });
});
