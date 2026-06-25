/**
 * Scheduler-control invocation tests (issue #12). Pausing must *also* disable the Windows
 * Task Scheduler jobs (belt-and-suspenders on top of the SQLite flag), and resuming re-enables
 * them. Like `agentInvocation` (launch.ts), the argv is built pure here so it's unit-testable;
 * the actual spawn stays a thin shell in the server action. The PowerShell that calls
 * Enable/Disable-ScheduledTask lives in scripts/set-schedule-enabled.ps1.
 */
import { describe, it, expect } from "vitest";
import { scheduleControlInvocation, SCHEDULED_TASK_NAMES } from "./scheduler-control";

const SCRIPT = "C:\\repo\\scripts\\set-schedule-enabled.ps1";

describe("scheduleControlInvocation", () => {
  it("disables the jobs when pausing", () => {
    const inv = scheduleControlInvocation("pause", { scriptPath: SCRIPT });
    expect(inv.command).toBe("powershell.exe");
    expect(inv.args).toContain("-File");
    expect(inv.args).toContain(SCRIPT);
    expect(inv.args).toContain("-Action");
    expect(inv.args).toContain("Disable");
    // Never runs a user profile / prompts — same hardening as the scheduled task wrapper.
    expect(inv.args).toContain("-NoProfile");
  });

  it("enables the jobs when resuming", () => {
    const inv = scheduleControlInvocation("resume", { scriptPath: SCRIPT });
    expect(inv.args).toContain("-Action");
    expect(inv.args).toContain("Enable");
    expect(inv.args).not.toContain("Disable");
  });

  it("targets exactly the two registered task names (shared with register-task.ps1)", () => {
    expect(SCHEDULED_TASK_NAMES).toEqual(["VinylRoulette-MonthlyRun", "VinylRoulette-Catchup"]);
  });

  it("drives the task names from the shared constant (not the script's fallback default)", () => {
    const inv = scheduleControlInvocation("pause", { scriptPath: SCRIPT });
    const i = inv.args.indexOf("-TaskName");
    expect(i).toBeGreaterThanOrEqual(0);
    // Comma-joined so PowerShell binds it to the script's [string[]] -TaskName param.
    expect(inv.args[i + 1]).toBe(SCHEDULED_TASK_NAMES.join(","));
  });
});
