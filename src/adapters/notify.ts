/**
 * Real `NotificationAdapter` implementations — the local desktop notification auto-prep
 * raises when an order reaches PROPOSED. The interface + faking pattern live in `types.ts`;
 * this file holds the platform code, kept thin behind the seam so the lifecycle is exercised
 * with `FakeNotificationAdapter` and never touches the OS in tests.
 *
 * Title-hiding by design (CONTEXT.md → Two-phase buy): the message carries price + source
 * only, never the record title — the surprise survives until the arrival Reveal.
 *
 * A notification must never break a *completed* auto-prep: the Run has already parked a valid
 * PROPOSED Quote by the time we notify, so every implementation here swallows its own errors
 * (logs, never throws). A missed toast is a missed nudge, not a lost month.
 */
import { spawn } from "node:child_process";
import type { NotificationAdapter, ProposedNotification } from "./types";
import { formatGBP } from "@/store/money";

const HEADING = "A record is on its way";

/** The human-facing line — price + source, never the title. Shared so toast == console. */
export function proposedMessage(n: ProposedNotification): string {
  const source = n.source === "discogs" ? "Discogs" : "Amazon";
  return `Approve ${formatGBP(n.pricePence)} at ${source} to send this month's record.`;
}

/**
 * Fallback adapter: prints the nudge to stdout. Always works — including from a headless
 * scheduled `claude -p` Run, where the line lands in the Run log — so it is the safe default
 * on any platform without a native toast.
 */
export class ConsoleNotificationAdapter implements NotificationAdapter {
  async proposed(n: ProposedNotification): Promise<void> {
    console.log(`[notify] ${HEADING}: ${proposedMessage(n)}`);
  }
}

/**
 * Windows toast via the built-in WinRT notification API, driven through PowerShell so no npm
 * dependency is needed. Works from a headless Run because the toast is raised in Euan's
 * logged-in session. Any failure (no PowerShell, locked-down WinRT, etc.) falls back to a
 * console line rather than throwing — a completed auto-prep must not be undone by a UI hiccup.
 */
export class WindowsToastNotificationAdapter implements NotificationAdapter {
  constructor(private readonly appId = "Vinyl Roulette") {}

  async proposed(n: ProposedNotification): Promise<void> {
    const heading = HEADING;
    const body = proposedMessage(n);
    // Build the toast XML in PowerShell and hand it to the WinRT ToastNotificationManager.
    // Single-quoted PS literals; the heading/body are static + numeric-derived (no title),
    // so there is no untrusted interpolation to escape.
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null",
      "$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
      "$texts = $xml.GetElementsByTagName('text')",
      `$texts.Item(0).AppendChild($xml.CreateTextNode('${psEscape(heading)}')) | Out-Null`,
      `$texts.Item(1).AppendChild($xml.CreateTextNode('${psEscape(body)}')) | Out-Null`,
      "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
      `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${psEscape(this.appId)}').Show($toast)`,
    ].join("; ");

    try {
      await runPowerShell(script);
    } catch (err) {
      // Degrade, never throw: the Quote is already safely PROPOSED.
      console.warn(
        `[notify] toast failed (${err instanceof Error ? err.message : String(err)}); ` +
          `${heading}: ${body}`,
      );
    }
  }
}

/** Escape a string for embedding inside a PowerShell single-quoted literal. */
function psEscape(s: string): string {
  return s.replace(/'/g, "''");
}

/** Run a PowerShell snippet, resolving on exit 0 and rejecting otherwise. */
function runPowerShell(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, stdio: "ignore" },
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`powershell exited ${code}`)),
    );
  });
}

/**
 * Build the production notification adapter for the current platform: a native Windows toast
 * (the deploy target — ADR-0003 is local-only on Euan's Windows box), else a console nudge.
 */
export function notificationAdapterFromEnv(
  platform: NodeJS.Platform = process.platform,
): NotificationAdapter {
  return platform === "win32"
    ? new WindowsToastNotificationAdapter()
    : new ConsoleNotificationAdapter();
}
