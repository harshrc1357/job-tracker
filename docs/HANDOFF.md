# Handoff: application linking build

Spec: GitHub issue 1. Tickets: issues 2 to 10. Branch: `claude/stoic-hawking-s8uwdm`. Read `GLOSSARY.md` and `docs/linking-scenarios.md` first.

## State

Built and tested without any secrets (run `npm test`; PGlite runs real SQL in-process):
- `src/lib/link/` — linker (`decideLink`), stage rules (`nextState`), batch planner (`planLinks`), DB adapter (`store`), overrides and Review answers (`actions`), page rules (`views`).
- Classifier now returns employer, role and round in the same single call.
- Pages: Pipeline `/`, Applications `/applications`, Detail `/applications/[id]`, Inbox `/inbox`, Review `/review`.
- `npm run preview:db` serves synthetic data so you can click through the UI with no real data.

## Needs your machine (real DB and keys), in this order

1. Back up the database, or use a Supabase branch.
2. `npm run migrate:linking`, then `npm run db:secure` (adds RLS to the new tables). The migration also adds `employer` and `via` columns to emails. Emails stored before this have no `employer` until `link:history` re-extracts them, so they wait rather than being linked by a sender-name guess.
3. `npm run backfill:threads -- --dry-run`, then `npm run backfill:threads`.
4. `npm run eval:extraction -- --sample=100`, hand-fill the `expected` fields in `logs/extraction-eval.json`, then `npm run eval:extraction -- --score`. Do this before step 5.
5. Set `LLM_CALLS_PER_DAY=3000` in your local `.env` only. `npm run link:history -- --dry-run`, then `npm run link:history`. Unset the variable afterwards. See `docs/llm-limits-audit.md`.
6. Check Vercel for a `SYNC_LOOKBACK_DAYS` override, then deploy.

## Known gaps

- Mail the classifier skipped before the Screening and Staffing/recruiter categories existed is recorded in `ignored_messages` and is never fetched again. To recover recruiter mail from the last 60 days, you can delete those rows and let the sync re-read them, for example `delete from ignored_messages where created_at > now() - interval '60 days';`. Every deleted row costs one more LLM call and the sync is capped at 80 calls a run and 1,000 a day per model, so check the row count first. This is optional and not done for you.
- The Gmail search (`buildJobQuery`) now also matches `recruiter`, `"phone screen"`, `"screening call"`, `"intro call"` and `"job description"`. That fetches more mail, so expect more LLM calls per run than before.
- In-house recruiter cold outreach is classified as Screening, so it also sends Telegram messages. Confirm that is what you want once real mail comes through.
- The UI keeps the app's existing light theme; the mockups were dark. Colours are CSS variables in `globals.css`.
- Linking is not yet exercised against production data volumes. Watch Review and flagged links after the first run.
