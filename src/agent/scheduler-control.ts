/**
 * Enabling/disabling the Windows Task Scheduler jobs that fire the monthly Run (issue #12).
 *
 * Pause is a two-part control (CONTEXT.md → Kill switch): a flag in SQLite AND disabling the
 * scheduled job. The SQLite flag is the authoritative gate every Run path already checks
 * (run.ts); disabling the OS task is defence-in-depth so the scheduler doesn't even *fire*
 * while paused. Resuming re-enables both.
 *
 * Mirrors `agentInvocation` (launch.ts): the command line is built here as a pure, testable
 * value; the real `spawn` stays a thin, untested shell in the server action. The PowerShell that
 * actually calls Enable/Disable-ScheduledTask lives in scripts/set-schedule-enabled.ps1 (toggling
 * tasks needs the ScheduledTasks module — Windows-only, hence kept out of Node).
 */

/**
 * The two task names register-task.ps1 creates — the monthly cadence + the at-logon catch-up.
 * Shared as the single source of truth so the toggle targets exactly what was registered. (If a
 * task was registered under a custom name, pass it through to the script's -TaskName param.)
 */
export const SCHEDULED_TASK_NAMES = [
  "VinylRoulette-MonthlyRun",
  "VinylRoulette-Catchup",
] as const;

export type ScheduleAction = "pause" | "resume";

export interface ScheduleControlInvocation {
  command: string;
  args: string[];
}

export interface ScheduleControlOptions {
  /** Absolute path to set-schedule-enabled.ps1. Injectable for tests; the action resolves it
   *  against the repo root at call time. */
  scriptPath: string;
  /** The task names to toggle. Defaults to `SCHEDULED_TASK_NAMES` — passed through so the TS
   *  constant, not the script's own default, is the single source of truth. */
  taskNames?: readonly string[];
}

/**
 * Build the PowerShell command line that pauses (disables) or resumes (enables) the scheduled
 * jobs. `-NoProfile`/`-ExecutionPolicy Bypass` match the scheduled-task wrapper's hardening so a
 * developer profile or policy can't change behaviour. The task names ride along as `-TaskName`
 * (comma-joined → a PowerShell string array) so `SCHEDULED_TASK_NAMES` actually drives which jobs
 * are toggled rather than relying on the script's fallback default.
 */
export function scheduleControlInvocation(
  action: ScheduleAction,
  opts: ScheduleControlOptions,
): ScheduleControlInvocation {
  const psAction = action === "pause" ? "Disable" : "Enable";
  const taskNames = opts.taskNames ?? SCHEDULED_TASK_NAMES;
  return {
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      opts.scriptPath,
      "-Action",
      psAction,
      "-TaskName",
      taskNames.join(","),
    ],
  };
}
