/**
 * Monthly scheduling logic (issue #11). The Run is fired by Windows Task Scheduler (ADR-0001) via
 * two jobs (see scripts/register-task.ps1): a monthly cadence trigger that always runs, and an
 * at-logon catch-up that invokes the entrypoint with `--if-due`. This module is the pure decision
 * the catch-up gates on, so "a missed monthly trigger runs at next boot" is a unit-testable rule
 * rather than a property of the OS scheduler alone. The guard governs only the catch-up — never
 * the monthly cadence, which must fire unconditionally so a legitimate month is never suppressed.
 */

/**
 * The "a month is overdue" threshold for the at-logon catch-up, in days (CONTEXT.md → Run is
 * "~monthly"). 28, the shortest calendar month, so the catch-up treats a month as owed once the
 * shortest possible monthly gap has fully elapsed — it never fires while the monthly cadence is
 * still on time, only when a fire was genuinely missed. Elapsed-days (not calendar arithmetic)
 * keeps the guard timezone-independent.
 */
export const MONTHLY_RUN_INTERVAL_DAYS = 28;

/**
 * Is this period's scheduled Run still owed? Given the start time of the most recent *scheduled*
 * Run (or null if none ever ran), returns true once at least `intervalDays` have elapsed. Only the
 * at-logon catch-up gates on this (the monthly cadence trigger runs unconditionally), so:
 *   - a logon the day after a Run is a no-op (1 day < interval → not due);
 *   - a logon after the machine was off for a month catches the missed beat (→ due), and runs once
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
