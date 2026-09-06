# Hits the deployed /api/sync endpoint. Run on a schedule by the JobTrackerSync
# task (see register-sync-task.ps1).
#
# Why this exists alongside .github/workflows/sync.yml: GitHub throttles scheduled
# workflows hard on free runners. The workflow asks for */5 and actually fires every
# 3-4 hours, which is useless for "you have an interview in 8 hours". This machine is
# already on all day for ClaudeClaw, so it can do the polling honestly. The Action
# stays as a backstop for when the machine is off.
#
# Reads CRON_SECRET straight out of .env — never pass it on the command line, where
# it would land in the task definition and in process listings.

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectRoot ".env"
$logPath = Join-Path $projectRoot "sync-trigger.log"

$SYNC_URL = "https://job-tracker-sage-eta.vercel.app/api/sync"

function Write-Log([string]$Message) {
    $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
    Add-Content -Path $logPath -Value $line -Encoding utf8
}

if (-not (Test-Path $envPath)) {
    Write-Log "FAIL .env not found at $envPath"
    exit 1
}

$secret = $null
foreach ($line in Get-Content $envPath) {
    if ($line -match '^CRON_SECRET=(.*)$') {
        $secret = $Matches[1].Trim('"')
    }
}

if ([string]::IsNullOrWhiteSpace($secret)) {
    Write-Log "FAIL CRON_SECRET missing from .env"
    exit 1
}

try {
    $response = Invoke-RestMethod -Uri "$SYNC_URL`?secret=$secret" -Method Get -TimeoutSec 90

    # Dump the full response next to the log so a run can be inspected afterwards.
    # The body carries no secret — the secret only ever travels in the request.
    $responsePath = Join-Path $projectRoot "sync-last-response.json"
    $response | ConvertTo-Json -Depth 6 | Set-Content -Path $responsePath -Encoding utf8

    $errorCount = @($response.errors).Count
    $summary = "ok inserted=$($response.inserted) reminders=$($response.remindersSent) remaining=$($response.remaining) errors=$errorCount"
    Write-Log $summary
} catch {
    # The route alerts to Telegram itself for anything it can catch. This log is for
    # the cases it cannot: the function being killed outright, or the box being offline.
    Write-Log "FAIL $($_.Exception.Message)"
    exit 1
}
