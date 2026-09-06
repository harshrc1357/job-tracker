# Registers (or re-registers) the JobTrackerSync scheduled task: runs
# trigger-sync.ps1 every 5 minutes, hidden, for the current user.
#
# Run once: powershell -ExecutionPolicy Bypass -File scripts\register-sync-task.ps1
# Remove:   Unregister-ScheduledTask -TaskName JobTrackerSync -Confirm:$false

$ErrorActionPreference = "Stop"

$taskName = "JobTrackerSync"
$scriptPath = Join-Path $PSScriptRoot "trigger-sync.ps1"

if (-not (Test-Path $scriptPath)) {
    throw "trigger-sync.ps1 not found next to this script"
}

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`""

# RepetitionDuration of [TimeSpan]::MaxValue is how you say "forever" here; a plain
# large number gets silently clamped.
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) `
    -RepetitionDuration ([TimeSpan]::MaxValue)

# StartWhenAvailable catches up after the machine sleeps rather than skipping the
# window entirely. No battery conditions: this must run on a laptop on battery too.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -MultipleInstances IgnoreNew

# DOMAIN\user, not a bare username — Task Scheduler rejects the bare form with
# "The parameter is incorrect".
$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Limited

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Polls job-tracker /api/sync every 5 minutes. GitHub Actions throttles its own schedule to hours." | Out-Null

Write-Output "Registered $taskName (every 5 minutes)."
