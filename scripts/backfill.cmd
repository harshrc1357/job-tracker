@echo off
REM Detached backfill runner.
REM
REM Starts the backfill in its own window, writing to logs\backfill.log, and returns
REM immediately. Nothing supervises it: not this shell, not an agent, not a serverless
REM timeout. Close the terminal and it keeps going.
REM
REM   scripts\backfill.cmd              45 days, live
REM   scripts\backfill.cmd --days=21    narrower window
REM   scripts\backfill.cmd --dry-run    count only, no LLM calls, no writes
REM
REM Watch it with:  powershell -Command "Get-Content logs\backfill.log -Wait -Tail 20"

setlocal
cd /d "%~dp0.."
if not exist logs mkdir logs

echo Starting backfill in the background.
echo Log: %CD%\logs\backfill.log
echo.
echo Follow it with:
echo   powershell -Command "Get-Content logs\backfill.log -Wait -Tail 20"

REM start /b detaches from this console but keeps the process alive after it closes.
REM Output is redirected rather than piped, so lines land in the file as they are
REM written instead of sitting in a pipe buffer until the process exits.
start "job-tracker backfill" /b cmd /c "npx tsx --env-file=.env scripts\backfill.mts %* >> logs\backfill.log 2>&1"

endlocal
