/**
 * The canonical command that fires a Run (issue #11 / ADR-0001). One source of truth shared by
 * the "Run now" button (which spawns it as a detached child) and — by convention, mirrored in
 * `scripts/register-task.ps1` — the Windows Task Scheduler job. Keeping the argv pure makes it
 * unit-testable; the actual `spawn` stays a thin, untested shell in the server action.
 *
 * Today the entrypoint is the Node script (`npm run agent:run`); the in-context Brain that
 * `claude -p` will drive is a separate, not-yet-shipped slice (see run.ts). The swap is one line
 * of local config: set VINYL_AGENT_CMD to the real `claude -p "<prompt>"`. Per ADR-0001 that
 * invocation authenticates via the CLAUDE_CODE_OAUTH_TOKEN env var (Euan's Pro/Max subscription)
 * and must never pass `--bare` (which forces a metered API key) — this builder never emits it.
 */
import type { RunTrigger } from "@/store/types";

export interface AgentInvocation {
  command: string;
  args: string[];
}

export interface AgentInvocationOptions {
  /** Add the `--if-due` catch-up guard so a monthly/boot trigger that already ran this period
   *  is a no-op (the missed-trigger catch-up). Off for "Run now", which always runs immediately. */
  ifDue?: boolean;
  /** Injectable for tests; defaults to the process environment. */
  env?: Record<string, string | undefined>;
  /** Injectable for tests; defaults to the host platform (npm is `npm.cmd` on Windows). */
  platform?: NodeJS.Platform;
}

/**
 * Build the command line that runs one agent Run. `trigger` tags the Run row; `ifDue` adds the
 * catch-up guard. A `VINYL_AGENT_CMD` override (a full command line, e.g. `claude -p "..."`) is
 * honoured verbatim with the trigger/catch-up flags appended — the local config knob for swapping
 * in the real Brain without touching the button or the scheduled task.
 */
export function agentInvocation(
  trigger: RunTrigger,
  opts: AgentInvocationOptions = {},
): AgentInvocation {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;

  const flags = ["--trigger", trigger];
  if (opts.ifDue) flags.push("--if-due");

  const override = env.VINYL_AGENT_CMD?.trim();
  if (override) {
    // A trusted local config line (not user input): split on whitespace, append our flags.
    const [command = "", ...rest] = override.split(/\s+/);
    return { command, args: [...rest, ...flags] };
  }

  // Default: the npm script documented in the README. npm is `npm.cmd` on Windows; the `--`
  // forwards the flags through npm to the underlying tsx entrypoint.
  const npm = platform === "win32" ? "npm.cmd" : "npm";
  return { command: npm, args: ["run", "agent:run", "--", ...flags] };
}
