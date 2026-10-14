# job-tracker

Next.js + Drizzle/Postgres app that syncs job-related Gmail, classifies it with an LLM, and sends Telegram reminders.

## Handoff

Resuming the Applications build (issues #1 to #16, PRs #11 and #17), running its real-data steps, or merging anything: read `docs/HANDOFF.md` first. It names the branch to work on.

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues for `harshrc1357/job-tracker`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
