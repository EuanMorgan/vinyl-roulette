<#
.SYNOPSIS
  Enable or disable the Vinyl Roulette scheduled Run jobs (issue #12 — the Pause control surface).

.DESCRIPTION
  Pause is two effects (CONTEXT.md -> Kill switch): a flag in SQLite AND disabling the Windows
  Task Scheduler jobs. The SQLite flag is the authoritative gate every Run path checks (run.ts);
  disabling the OS tasks here is defence-in-depth so the scheduler doesn't even fire while paused.

  Idempotent and forgiving: a task that doesn't exist (scheduler never registered) is skipped with
  a note rather than erroring, so toggling Pause is safe even before register-task.ps1 has run. The
  task names default to the two register-task.ps1 creates; pass -TaskName to target custom names.

  Invoked by the UI's Pause toggle via `scheduleControlInvocation` (src/agent/scheduler-control.ts).

.PARAMETER Action
  'Disable' to pause (stop future Runs firing), 'Enable' to resume.

.PARAMETER TaskName
  The scheduled task(s) to toggle. Defaults to the pair register-task.ps1 registers.

.EXAMPLE
  pwsh -File scripts/set-schedule-enabled.ps1 -Action Disable
  pwsh -File scripts/set-schedule-enabled.ps1 -Action Enable
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateSet('Enable', 'Disable')]
  [string]$Action,
  [string[]]$TaskName = @('VinylRoulette-MonthlyRun', 'VinylRoulette-Catchup')
)

$ErrorActionPreference = 'Stop'

foreach ($name in $TaskName) {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if (-not $task) {
    Write-Host "No scheduled task '$name' to $($Action.ToLower()) (register with scripts/register-task.ps1)."
    continue
  }
  if ($Action -eq 'Disable') {
    Disable-ScheduledTask -TaskName $name | Out-Null
    Write-Host "Disabled '$name' - it will not fire while paused."
  } else {
    Enable-ScheduledTask -TaskName $name | Out-Null
    Write-Host "Enabled '$name' - the monthly cadence is live again."
  }
}
