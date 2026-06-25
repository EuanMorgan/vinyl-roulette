<#
.SYNOPSIS
  Fire one Vinyl Roulette Run (issue #11). This is the wrapper the Windows Task Scheduler job
  invokes, and it doubles as a hand-runnable launcher. It mirrors `agentInvocation` in
  src/agent/launch.ts: the default entrypoint is `npm run agent:run`, overridable with the
  VINYL_AGENT_CMD env var for the future `claude -p` Brain - and `--bare` is never added
  (ADR-0001: --bare forces a metered API key instead of the CLAUDE_CODE_OAUTH_TOKEN subscription).

.DESCRIPTION
  Loads .env from the repo root so CLAUDE_CODE_OAUTH_TOKEN (and the rest) are present in the Run's
  environment, then runs the agent. Runs in Euan's logged-in session, so the buy step can reuse his
  authenticated Chrome/Amazon/Discogs/PayPal sessions (ADR-0003, local only). Kept short by design
  - the auto-prep decide -> price -> cart Run fits inside the ~10-15 min OAuth headless window.

.PARAMETER Trigger
  Tags the Run row: 'scheduled' (the monthly job) or 'manual' (a one-off). Default 'scheduled'.

.PARAMETER IfDue
  Add the catch-up guard (--if-due): only actually Run if this month's scheduled Run is still owed.
  The scheduled task passes this so a logon/boot catch-up never double-buys.
#>
[CmdletBinding()]
param(
  [ValidateSet('scheduled', 'manual')]
  [string]$Trigger = 'scheduled',
  [switch]$IfDue
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

# Load .env into the process environment so the agent (and the future `claude -p`) sees
# CLAUDE_CODE_OAUTH_TOKEN, VINYL_DB_PATH, VINYL_AGENT_CMD, etc. Simple KEY=VALUE parser:
# skip blanks/comments, take everything after the first '=', strip optional surrounding quotes.
$envFile = Join-Path $repoRoot '.env'
if (Test-Path $envFile) {
  foreach ($line in Get-Content $envFile) {
    $trimmed = $line.Trim()
    if ($trimmed -eq '' -or $trimmed.StartsWith('#')) { continue }
    $eq = $trimmed.IndexOf('=')
    if ($eq -lt 1) { continue }
    $key = $trimmed.Substring(0, $eq).Trim()
    $value = $trimmed.Substring($eq + 1).Trim().Trim('"').Trim("'")
    if ($value -ne '') { Set-Item -Path "Env:$key" -Value $value }
  }
}

$flags = @('--trigger', $Trigger)
if ($IfDue) { $flags += '--if-due' }

if ($env:VINYL_AGENT_CMD) {
  # Trusted local override (e.g. `claude -p prompt.md`): run it through cmd with our flags appended.
  $cmd = "$($env:VINYL_AGENT_CMD) $($flags -join ' ')"
  Write-Host "[run-agent] $cmd"
  & cmd /c $cmd
} else {
  Write-Host "[run-agent] npm run agent:run -- $($flags -join ' ')"
  & npm run agent:run -- @flags
}

exit $LASTEXITCODE
