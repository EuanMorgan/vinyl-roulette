/**
 * The shared Run-firing command (issue #11). The "Run now" button spawns this, and
 * scripts/register-task.ps1 mirrors its default form. Asserting the argv here keeps both
 * call sites honest — especially the ADR-0001 invariant that `--bare` is never emitted.
 */
import { describe, it, expect } from "vitest";
import { agentInvocation } from "./launch";

describe("agentInvocation", () => {
  it("defaults to the npm entrypoint with the trigger forwarded through `--`", () => {
    const inv = agentInvocation("manual", { env: {}, platform: "linux" });
    expect(inv).toEqual({ command: "npm", args: ["run", "agent:run", "--", "--trigger", "manual"] });
  });

  it("uses npm.cmd on Windows", () => {
    const inv = agentInvocation("scheduled", { env: {}, platform: "win32" });
    expect(inv.command).toBe("npm.cmd");
  });

  it("appends --if-due for the monthly/boot catch-up triggers", () => {
    const inv = agentInvocation("scheduled", { env: {}, platform: "linux", ifDue: true });
    expect(inv.args).toEqual(["run", "agent:run", "--", "--trigger", "scheduled", "--if-due"]);
  });

  it("does not add --if-due for an on-demand Run", () => {
    const inv = agentInvocation("manual", { env: {}, platform: "linux" });
    expect(inv.args).not.toContain("--if-due");
  });

  it("honours a VINYL_AGENT_CMD override, appending the trigger/catch-up flags", () => {
    const inv = agentInvocation("scheduled", {
      env: { VINYL_AGENT_CMD: "claude -p prompt.md" },
      platform: "win32",
      ifDue: true,
    });
    expect(inv).toEqual({
      command: "claude",
      args: ["-p", "prompt.md", "--trigger", "scheduled", "--if-due"],
    });
  });

  it("never emits --bare (ADR-0001: --bare forces a metered API key)", () => {
    for (const env of [{}, { VINYL_AGENT_CMD: "claude -p prompt.md" }]) {
      const inv = agentInvocation("scheduled", { env, platform: "win32", ifDue: true });
      expect([inv.command, ...inv.args]).not.toContain("--bare");
    }
  });
});
