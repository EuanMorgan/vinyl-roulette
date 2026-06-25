<#
.SYNOPSIS
  Register (or remove) the Windows Task Scheduler job that fires the monthly Vinyl Roulette Run
  (issue #11 / ADR-0001). Local-only by design: the Run executes in Euan's logged-in session so the
  buy step reuses his authenticated browser/PayPal sessions — no VPS, no fresh-login wall.

.DESCRIPTION
  Creates one task with two triggers, both running scripts/run-agent.ps1 with `-Trigger scheduled
  -IfDue`:
    * a MONTHLY trigger (default: the 1st at 09:00) — the normal cadence; and
    * an AT-LOGON trigger (delayed) — the missed-trigger catch-up.
  "A missed monthly trigger runs at next boot" is covered two ways: StartWhenAvailable=true reruns a
  missed monthly start as soon as the machine is available again, and the at-logon trigger re-checks
  on every sign-in. Both are gated by run.ts's `--if-due` guard (monthlyRunDue), so a catch-up never
  double-buys — the period is owed at most once.

  ExecutionTimeLimit is capped at 15 minutes to keep each Run inside the OAuth headless window
  (ADR-0001: OAuth tokens aren't auto-refreshed in long headless runs).

  NOTE: Pausing is the control surface in issue #12 — it disables this task (and sets the SQLite
  flag). This script only registers/removes it.

.PARAMETER Unregister
  Remove the task instead of creating it.

.EXAMPLE
  pwsh -File scripts/register-task.ps1
  pwsh -File scripts/register-task.ps1 -Time 08:30 -DayOfMonth 2
  pwsh -File scripts/register-task.ps1 -Unregister
#>
[CmdletBinding()]
param(
  [string]$TaskName = 'VinylRoulette-MonthlyRun',
  [ValidatePattern('^\d{2}:\d{2}$')]
  [string]$Time = '09:00',
  [ValidateRange(1, 28)]
  [int]$DayOfMonth = 1,
  [switch]$Unregister
)

$ErrorActionPreference = 'Stop'

if ($Unregister) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task '$TaskName'."
  } else {
    Write-Host "No scheduled task '$TaskName' to remove."
  }
  return
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$wrapper = Join-Path $repoRoot 'scripts\run-agent.ps1'
$user = "$env:USERDOMAIN\$env:USERNAME"

# StartBoundary only needs a valid date in the past for the time-of-day; the month/day schedule
# below drives recurrence. Build a fixed reference date at the requested clock time.
$startBoundary = "2026-01-${DayOfMonth:D2}T${Time}:00"

# All twelve months — a monthly recurrence on $DayOfMonth.
$months = (1..12 | ForEach-Object { "        <$([System.Globalization.CultureInfo]::InvariantCulture.DateTimeFormat.GetMonthName($_))/>" }) -join "`r`n"

$arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$wrapper`" -Trigger scheduled -IfDue"

# Define the task as XML so we get a true monthly calendar trigger + a logon catch-up + the
# settings we need, independent of the host's ScheduledTasks module version.
$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Vinyl Roulette monthly auto-buy Run (issue #11). Fires npm run agent:run via scripts/run-agent.ps1; --if-due makes a missed-month catch-up safe.</Description>
    <URI>\$TaskName</URI>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>$startBoundary</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByMonth>
        <DaysOfMonth>
          <Day>$DayOfMonth</Day>
        </DaysOfMonth>
        <Months>
$months
        </Months>
      </ScheduleByMonth>
    </CalendarTrigger>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>$user</UserId>
      <Delay>PT3M</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$user</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT15M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>$arguments</Arguments>
      <WorkingDirectory>$repoRoot</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@

Register-ScheduledTask -TaskName $TaskName -Xml $xml -User $user -Force | Out-Null

Write-Host "Registered '$TaskName':"
Write-Host "  monthly  : day $DayOfMonth at $Time (StartWhenAvailable -> catches a missed month)"
Write-Host "  at logon : +3 min, --if-due (no-op unless a month is owed)"
Write-Host "  action   : powershell -File $wrapper -Trigger scheduled -IfDue"
Write-Host ""
Write-Host "Run once now to verify:  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Remove it later with:    pwsh -File scripts/register-task.ps1 -Unregister"
