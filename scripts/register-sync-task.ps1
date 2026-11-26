# Registers (or re-registers) the JobTrackerSync scheduled task: runs
# trigger-sync.ps1 every 5 minutes, hidden, for the current user.
#
# Run once: powershell -ExecutionPolicy Bypass -File scripts\register-sync-task.ps1
# Remove:   schtasks /Delete /TN JobTrackerSync /F
#
# Uses schtasks.exe rather than the ScheduledTasks cmdlets on purpose. The cmdlet
# route needs New-ScheduledTaskTrigger -Once with a RepetitionDuration meaning
# "forever", and neither documented spelling works here: [TimeSpan]::MaxValue
# serialises to P99999999DT23H59M59S and [TimeSpan]::Zero to PT0S, and Task
# Scheduler rejects both with "The task XML contains a value which is incorrectly
# formatted or out of range." schtasks /SC MINUTE /MO 5 expresses the same thing
# natively and repeats indefinitely with no duration field at all.

$ErrorActionPreference = "Stop"

$taskName = "JobTrackerSync"
$scriptPath = Join-Path $PSScriptRoot "trigger-sync.ps1"

if (-not (Test-Path $scriptPath)) {
    throw "trigger-sync.ps1 not found next to this script"
}

# -WindowStyle Hidden keeps a console from flashing up every five minutes.
$command = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`""

# /F overwrites an existing registration, making this script safe to re-run.
# /RL LIMITED runs unelevated: this only makes an outbound HTTPS call.
schtasks /Create `
    /TN $taskName `
    /TR $command `
    /SC MINUTE `
    /MO 5 `
    /RL LIMITED `
    /F | Out-Null

if ($LASTEXITCODE -ne 0) {
    throw "schtasks /Create failed with exit code $LASTEXITCODE"
}

# Start it now rather than waiting up to five minutes for the first tick.
schtasks /Run /TN $taskName | Out-Null

Write-Output "Registered $taskName (every 5 minutes) and triggered a first run."
