/**
 * Monthly scheduling logic (issue #11). The Run is fired by Windows Task Scheduler (ADR-0001):
 * a monthly trigger plus an AtStartup trigger, both invoking the agent entrypoint with `--if-due`.
 * This module is the pure decision both triggers share, so "a missed monthly trigger runs at next
 * boot" is a unit-testable rule rather than a property of the OS scheduler alone.
 */

/**
 * Roughly-monthly cadence, in days (CONTEXT.md → Run is "~monthly"). Deliberately 28, not a
 * calendar month: an elapsed-days window can't double-fire near a month boundary (a Run on the
 * 30th then the 1st), and it makes the catch-up independent of timezone/calendar arithmetic.
 */
export const MONTHLY_RUN_INTERVAL_DAYS = 28;

/**
 * Is this period's scheduled Run still owed? Given the start time of the most recent *scheduled*
 * Run (or null if none ever ran), returns true once at least `intervalDays` have elapsed. The
 * monthly trigger and the boot catch-up both gate on this, so:
 *   - the monthly trigger fires on schedule (last scheduled Run ~a month ago → due);
 *   - a boot the day after that Run is a no-op (1 day < interval → not due);
 *   - a boot after the machine was off for a month catches the missed beat (→ due), and runs once
 *     (not twice) — we owe the current month, not the skipped ones.
 *
 * Fails open: a missing or unparseable timestamp is treated as never-run, so a corrupt clock
 * value triggers a Run rather than silently skipping a month.
 */
export function monthlyRunDue(
  lastScheduledRunAt: string | null,
  now: Date,
  intervalDays: number = MONTHLY_RUN_INTERVAL_DAYS,
): boolean {
  if (!lastScheduledRunAt) return true;
  const last = new Date(lastScheduledRunAt).getTime();
  if (Number.isNaN(last)) return true;
  const elapsedMs = now.getTime() - last;
  return elapsedMs >= intervalDays * 24 * 60 * 60 * 1000;
}
