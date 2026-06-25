<#
.SYNOPSIS
  Register (or remove) the Windows Task Scheduler jobs that fire the monthly Vinyl Roulette Run
  (issue #11 / ADR-0001). Local-only by design: the Run executes in Euan's logged-in session so the
  buy step reuses his authenticated browser/PayPal sessions — no VPS, no fresh-login wall.

.DESCRIPTION
  Creates TWO tasks, both running scripts/run-agent.ps1:

    * VinylRoulette-MonthlyRun  — a MONTHLY calendar trigger (default: the 1st at 09:00). The
      cadence. Action: `-Trigger scheduled` (NOT --if-due) so the monthly fire always runs.
      StartWhenAvailable=true means a start missed because the machine was off reruns as soon as
      the machine is available again — "a missed monthly trigger runs at next boot".

    * VinylRoulette-Catchup     — an AT-LOGON trigger (delayed 3 min). The belt-and-suspenders
      catch-up. Action: `-Trigger scheduled -IfDue`, so run.ts's `monthlyRunDue` guard fires it
      only when a month is genuinely overdue and skips it on every ordinary logon. Gating the
      *catch-up* (never the monthly cadence) is deliberate: a guard on the monthly trigger could
      suppress a legitimate fire when the prior Run was itself a late catch-up — the exact
      silently-skipped month the spec forbids.

  Both run in Euan's interactive session (LogonType InteractiveToken). ExecutionTimeLimit is capped
  at 15 minutes to keep each Run inside the OAuth headless window (ADR-0001: OAuth tokens aren't
  auto-refreshed in long headless runs).

  NOTE: Pausing is the control surface in issue #12 — it will disable these tasks (and set the
  SQLite flag). This script only registers/removes them.

.PARAMETER Unregister
  Remove both tasks instead of creating them.

.EXAMPLE
  pwsh -File scripts/register-task.ps1
  pwsh -File scripts/register-task.ps1 -Time 08:30 -DayOfMonth 2
  pwsh -File scripts/register-task.ps1 -Unregister
#>
[CmdletBinding()]
param(
  [string]$MonthlyTaskName = 'VinylRoulette-MonthlyRun',
  [string]$CatchupTaskName = 'VinylRoulette-Catchup',
  [ValidatePattern('^\d{2}:\d{2}$')]
  [string]$Time = '09:00',
  [ValidateRange(1, 28)]
  [int]$DayOfMonth = 1,
  [switch]$Unregister
)

$ErrorActionPreference = 'Stop'

function Remove-IfPresent($name) {
  if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
    Write-Host "Removed scheduled task '$name'."
  } else {
    Write-Host "No scheduled task '$name' to remove."
  }
}

if ($Unregister) {
  Remove-IfPresent $MonthlyTaskName
  Remove-IfPresent $CatchupTaskName
  return
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$wrapper = Join-Path $repoRoot 'scripts\run-agent.ps1'
$user = "$env:USERDOMAIN\$env:USERNAME"

# The wrapper invocation, shared shape; the monthly job omits -IfDue, the catch-up adds it.
function Wrapper-Arguments($ifDue) {
  $a = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$wrapper`" -Trigger scheduled"
  if ($ifDue) { $a += ' -IfDue' }
  return $a
}

# Build a full task definition (XML) from a trigger fragment + the action arguments. Defined as XML
# so we get a true monthly calendar trigger and the settings we need, independent of the host's
# ScheduledTasks module version.
function Build-TaskXml($description, $uri, $triggersXml, $arguments) {
  return @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>$description</Description>
    <URI>\$uri</URI>
  </RegistrationInfo>
  <Triggers>
$triggersXml
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
}

# --- Monthly cadence task -------------------------------------------------------------------------
$startBoundary = "2026-01-${DayOfMonth:D2}T${Time}:00"
$months = (1..12 | ForEach-Object {
    "          <$([System.Globalization.CultureInfo]::InvariantCulture.DateTimeFormat.GetMonthName($_))/>"
  }) -join "`r`n"

$monthlyTriggers = @"
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
"@

$monthlyXml = Build-TaskXml `
  'Vinyl Roulette monthly auto-buy Run (issue #11). The cadence; StartWhenAvailable reruns a missed month at next availability.' `
  $MonthlyTaskName $monthlyTriggers (Wrapper-Arguments $false)

# --- Logon catch-up task --------------------------------------------------------------------------
$catchupTriggers = @"
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>$user</UserId>
      <Delay>PT3M</Delay>
    </LogonTrigger>
"@

$catchupXml = Build-TaskXml `
  'Vinyl Roulette missed-month catch-up (issue #11). Runs at logon with --if-due, so it only fires when a month is overdue.' `
  $CatchupTaskName $catchupTriggers (Wrapper-Arguments $true)

Register-ScheduledTask -TaskName $MonthlyTaskName -Xml $monthlyXml -User $user -Force | Out-Null
Register-ScheduledTask -TaskName $CatchupTaskName -Xml $catchupXml -User $user -Force | Out-Null

Write-Host "Registered two tasks:"
Write-Host "  $MonthlyTaskName : monthly on day $DayOfMonth at $Time (ungated; StartWhenAvailable -> catches a missed month at next boot)"
Write-Host "  $CatchupTaskName : at logon +3 min, --if-due (no-op unless a month is overdue)"
Write-Host ""
Write-Host "Run once now to verify:  Start-ScheduledTask -TaskName '$MonthlyTaskName'"
Write-Host "Remove them later with:  pwsh -File scripts/register-task.ps1 -Unregister"
