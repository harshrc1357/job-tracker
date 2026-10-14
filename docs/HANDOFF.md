# Handoff: continue the Applications build on your machine

Written 2026-10-14. Read `GLOSSARY.md` for the vocabulary (Application, Employer, Via, Ghosted, Staffing/recruiter) and `docs/linking-scenarios.md` for the 51 cases the Linker handles.

**What is and is not proven.** Everything below was built in a cloud session that had no access to your database, Gmail, OpenRouter or Telegram. Verified there, on synthetic data: tests (332 pass), `tsc`, `next build`, and the pages in a real browser. **Not verified anywhere: any real model answer, any real mail, any real database.** Steps 1 to 8 are that first real run.

---

## 1. Where things stand

| What | Where | State |
|---|---|---|
| PR [#11](https://github.com/harshrc1357/job-tracker/pull/11), the linking build (issues #1 to #10) | branch `claude/stoic-hawking-s8uwdm` → `main` | Reviewed, blockers fixed. **Frozen.** Do not merge yet. |
| PR [#17](https://github.com/harshrc1357/job-tracker/pull/17), Screening, Staffing/recruiter, Ghosted for every open application (issues #13 to #15) | branch `claude/screening-staffing-ghosted` → `claude/stoic-hawking-s8uwdm` | Built test-first, then reviewed independently; the review's fixes are in. Merging it does **not** deploy. |
| Real-data run (steps 1 to 8 below) | your machine | **Not started.** |
| Cleanup [#16](https://github.com/harshrc1357/job-tracker/issues/16) | later, new branch from `main` | After both PRs are merged. |

## 2. Branches: which to work on, review, or leave alone

```text
main                                   production: Vercel deploys every merge
 └─ claude/stoic-hawking-s8uwdm        PR #11's branch   → REVIEW it, do not commit to it
     └─ claude/screening-staffing-ghosted   PR #17's branch → WORK HERE
```

| Branch | Your job |
|---|---|
| `main` | Never commit to it. It only receives PR #11. |
| `claude/stoic-hawking-s8uwdm` | **Review** PR #11 (the diff against `main`). Add nothing to it. It receives PR #17, then goes to `main`. |
| `claude/screening-staffing-ghosted` | **Work here.** It contains everything in PR #11 plus #13 to #15 plus the review fixes, so the real-data steps measure the final code. Fix bugs here, push, and PR #17 updates. |

Rules:

1. Run every real-data step from `claude/screening-staffing-ghosted`.
2. A code fix goes on that branch (or a branch made from it), never on `claude/stoic-hawking-s8uwdm`. It reaches `main` through the merges in step 9.
3. **Merge PR #17 first, then PR #11.** Merging #11 first deploys without #13 to #15 and the review fixes.
4. Do the real-data steps **before** merging anything. Merging #11 deploys, and the deployed code needs the migrated database.
5. After both merge, start new work (for example #16) on a new branch from `main`.

What to review: PR #17 is a small diff (about 35 files; read the commit list: one commit per ticket, then the review-fixes commit, the live-test commit and the docs). PR #11 is large (about 140 files), was reviewed with the `code-review` skill, and its blockers are fixed.

## 3. Before you start

Tools: `git`, Node and npm (the versions you already use for this project).

Your local `.env` must have these (never paste its contents anywhere):

| Needed by | Keys |
|---|---|
| every script | `DATABASE_URL` (the Supabase pooler string; the scripts open one connection). `db:secure` uses `DIRECT_URL` instead when it is set, because it runs `GRANT`/`REVOKE`, which need a stable connection: add the session-pooler or direct string as `DIRECT_URL` if `db:secure` fails on the transaction pooler |
| `backfill:threads`, `backfill` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, and a Gmail login already saved in the database (you have one: the app syncs today) |
| `eval:extraction`, `backfill`, `link:history` | `OPENROUTER_API_KEY`, and `OWNER_EMAIL` set to your own Gmail address (`link:history` uses it to tell your replies from other people's; if it is missing nothing fails, the links are just wrong) |
| `npm run dev` | also `SESSION_SECRET` and `GOOGLE_LOGIN_REDIRECT_URI=http://localhost:3000/api/auth/login/callback`, which must also be an authorised redirect URI on the Google OAuth client |

Get the code and prove it works on your machine (no database or keys needed; the tests run an in-process Postgres):

```text
git fetch origin
git switch claude/screening-staffing-ghosted
git pull
npm ci
npm test            # expect: 332 passed, 26 skipped
npm run typecheck   # expect: two banner lines starting with `>` and no errors
```

The 26 skipped tests are 18 that call the real models (they run only with `RUN_LIVE_LLM=1`, step 4c) and 8 that write to your real database (they run only with `RUN_DB_TESTS=1`). **Never set `RUN_DB_TESTS`.**

Commands below work in PowerShell and bash. Setting an environment variable differs: PowerShell `$env:NAME="value"`, bash `export NAME=value`. Where the doc says "set it in `.env`", edit the file instead.

---

## 4. Runbook

Do the steps in order. Each says what it writes, what you should see, and when to stop. **Stop and bring the output to Claude Code if anything differs.**

**Dry runs.** Several steps start with `-- --dry-run`. If PowerShell or npm ever drops the flag, the "dry run" is a real run. Every dry run finishes within seconds and prints `DRY RUN` (`backfill:threads`, `backfill`) or `Dry run: nothing written.` (`link:history`). If instead you see it counting up through `100/2356` or similar, press Ctrl-C.

**Pausing the sync.** Three things can call your live `/api/sync`; to pause it, stop all three:

| Trigger | Stop | Start again |
|---|---|---|
| Windows scheduled task `JobTrackerSync` (every 5 minutes, the main one; log in `sync-trigger.log` in the repo root) | `schtasks /Change /TN JobTrackerSync /DISABLE` | `schtasks /Change /TN JobTrackerSync /ENABLE` |
| GitHub Actions "Gmail sync" (the backstop) | Actions → Gmail sync → ⋯ → Disable workflow | Enable workflow |
| cron-job.org, if you still have a job there (the code mentions one) | pause the job | resume it |

What each command writes, at a glance:

| Command | Writes to the database | LLM calls | Safe to rerun |
|---|---|---|---|
| `migrate:linking` | adds columns and tables; nothing dropped or rewritten | 0 | yes |
| `db:secure` | locks the new tables from the public API | 0 | yes |
| `backfill:threads` | `thread_id` on old emails | 0 | yes, resumes |
| `eval:extraction` | nothing (writes `logs/extraction-eval.json`) | about the sample size | yes, but a second `--sample` overwrites the file, so rename a labelled one first |
| `backfill` | new emails found by the wider Gmail search; mail the classifier skips goes to `ignored_messages` | 1 to 2 per new message | yes, resumes |
| `link:history` | old emails get `employer`, `company`, `via`, `role`, `interview_round` (only where the model found a value); links; `job_applications`; `review_items` | 1 per old email not yet extracted | yes, resumes |
| `npm run dev` | only when you click an override | 0 | n/a |

### Step 1. Back up

Take a backup you could restore from. Either:

- the Supabase dashboard's Database → Backups page (what it offers depends on your plan; note the date of the latest one), or
- your own copy, with the PostgreSQL command-line tools and the session-pooler or direct connection string (the transaction pooler is not suitable for a dump):
  `pg_dump '<your connection string>' --no-owner --schema=public --format=custom --file=backups/job-tracker-before-linking.dump`
  Make the folder first (`mkdir backups`). Use **single quotes** (PowerShell expands `$` inside double quotes). The `backups/` folder is git-ignored. **The dump holds every email body and your Gmail refresh token: it must never reach GitHub.** `*.dump` is git-ignored as a second guard.

To restore, use the dashboard, or ask Claude Code to write the `pg_restore` command with you; do not improvise one on production.

Why: `link:history` overwrites the display `company` of old emails with the Employer the model read, and that is not reversible without a backup.

**Done when** you have a file, or a dashboard backup dated today.

### Step 2. Migrate and lock the new tables

```text
npm run migrate:linking
npm run db:secure
npm run db:secure:check
```

You should see: a line `ok: ...` per statement, then `emails: <N>, with thread_id: 0`. `db:secure` prints a Before table and an After table (one row per table: `rls`, `exposedTo`) and ends `All tables: RLS enabled, no grants to anon or authenticated.` `db:secure:check` prints one table and `--check: nothing was changed.`; every row should read `rls: true`, `exposedTo: (none)`.

This is safe to run before the merge: every added column is nullable or has a default, so the code currently deployed keeps working against the migrated database.

**Done when** all three finish without an error.

### Step 3. Fill thread ids on old emails

```text
npm run backfill:threads -- --dry-run
npm run backfill:threads
```

The dry run prints `<N> emails have no thread id`. The real run fills them from Gmail (no LLM calls) and resumes if interrupted. A few may stay empty if you deleted the mail from Gmail; that is fine.

**Done when** a second dry run reports 0, or only a handful.

### Step 4. Measure the classifier on your own mail (the gate)

This decides whether the prompt is good enough to spend step 6 on. `link:history` re-extracts every old email once, so a prompt problem found later cannot be undone cheaply.

**4a. Employer, role and round accuracy** (about 100 LLM calls):

```text
npm run eval:extraction -- --sample=100
```

Open `logs/extraction-eval.json`. For each row fill `"expected"` with `{"employer": "...", "role": "...", "round": null}`, using `null` where the email states none. Label at least 50 rows. Then:

```text
npm run eval:extraction -- --score
```

You get per-field accuracy and `invented roles` (a role the model made up where the email names none; the costly error, since a made-up role can attach to the wrong Application). A missing role is safe: the Linker asks. Judge the numbers yourself; as a starting point (my suggestion, not a measured threshold), employer accuracy should be high enough that you would trust the cards, and invented roles should be about 0.

Then rename the file so 4b does not overwrite your labels: `logs/extraction-eval.json` → `logs/extraction-eval-random.json`. If `--score` prints rows ending `-> (error)`, the key or the credits are wrong: fix that and rerun.

**4b. The new categories** (about 150 calls, no labelling needed). A random sample is mostly Applied mail, so aim at the categories that could move:

```text
npm run eval:extraction -- --sample=150 '--categories=Interview,Assessment,Offer,Reminder'
npm run eval:extraction -- --score
```

Keep the quotes: PowerShell splits an unquoted comma list into separate arguments, and the script would silently see only `Interview`. Ignore the `0.0%` accuracy lines (nothing is labelled). Read the part that follows: every email whose category the **new** prompt would change, as `Interview -> Screening: 3 (ids 12, 40, 77)`. Open those rows in `logs/extraction-eval.json`; each shows the subject, sender, what is stored now and the model's evidence. Judge each by eye:

| Shift | Good | Bad |
|---|---|---|
| `Interview → Screening` | a recruiter intro or phone screen | a hiring-manager or technical interview |
| `Assessment → Screening` | never expected | a test being called a screening |
| `→ Staffing/recruiter` | an agency recruiter's job description; evidence names the client | a hiring company's own mail |
| `→ (skipped)` | a newsletter or blast | anything you would have wanted |

This only re-judges mail you already stored. Mail the old prompt skipped was never stored, so its first test is step 5.

**4c. Live-model tests** (about 20 calls, a fraction of a cent). These run fixed example emails through the real models:

```text
$env:RUN_LIVE_LLM="1"        # PowerShell   (bash: export RUN_LIVE_LLM=1)
node --env-file=.env node_modules/vitest/vitest.mjs run src/lib/classify/liveClassifier.test.ts
```

The new recruiter cases were written from the prompt's rules and have never run against a model. A failure is a finding about the prompt to read, not automatically a bug. Unset it afterwards: `Remove-Item Env:RUN_LIVE_LLM` (PowerShell) or `unset RUN_LIVE_LLM` (bash).

**Gate.** Continue if employer and role look trustworthy and there are no patterns in the bad column. If there is a pattern, stop and give Claude Code the printed `--score` output (ids and counts only, never the file) and ask it to adjust the prompt test-first.

One decision to look out for here is in section 7 (an agency job description that also asks for your availability becomes Screening).

### Step 5. Quietly store mail the wider Gmail search now finds

The search now also matches `recruiter`, `"phone screen"`, `"screening call"`, `"intro call"` and `"job description"`. Production has never seen that mail. After the deploy, the live sync would find up to 60 days of it, store it as new, and **send a Telegram message for every Screening, Interview, Assessment or Offer among it, however old**. `backfill` stores the same mail and never sends Telegram.

Set `LLM_CALLS_PER_DAY=3000` in `.env`, then:

```text
npm run backfill -- --dry-run
npm run backfill
```

The dry run prints a line for each of 12 five-day chunks (`chunk 3 (10-15d ago): 41 listed, 6 new`); the "new" numbers added up are how many messages it will classify, at roughly one call each. It skips ids already in the database and resumes if interrupted. When the day's cap is spent it stops with `Daily LLM cap reached. Stopping here ... rerun tomorrow and it resumes from this point.`

**LLM budget, for steps 5 and 6.** `LLM_CALLS_PER_DAY` is a cap **per model**. After 3,000 calls on the primary model (`google/gemini-2.5-flash-lite`) the fallback (`openai/gpt-5-nano`) takes over silently, and step 4 never measured the fallback. The daily counter is also shared with the live sync on Vercel, which keeps its own cap of 1,000: on the day you run steps 5 and 6 the live sync may fall back to the other model or pause until tomorrow, and may send you a budget alert on Telegram. That is expected.

**Done when** a dry run shows 0 new in every chunk.

### Step 6. Build the Applications from history

```text
npm run link:history -- --dry-run
npm run link:history
```

The dry run prints `phase 1: <N> emails in the last 60 days need employer/role extraction` (one LLM call each; the audit estimates up to about 2,356, which is a guess from the code, so trust your own N) and `phase 2: <M> emails would be linked`. With step 5 that may pass the 3,000 cap. If it prints `stopped early`, rerun later and it resumes; if it stops with nothing done, check `OPENROUTER_API_KEY` and your OpenRouter credits, because a bad key stops it the same way. It will not link until extraction is complete.

**Done when** the log ends `phase 2 done: <X> applications created, <Y> emails attached, <Z> need review, <W> ignored` **and** a second `npm run link:history -- --dry-run` prints `phase 1: 0 emails` (an email that failed once, `skipped #<id>`, is left unextracted and unlinked, yet the run still ends with `phase 2 done`). **Write the four numbers down.** Then **remove `LLM_CALLS_PER_DAY` from `.env`**; forgetting it turns a one-off allowance into a standing one.

My rule of thumb, not a measured limit: if `need review` is more than about one in ten of `attached + created`, bring the numbers to Claude Code before merging.

### Step 7. Look at it, locally, on your real data

```text
npm run dev
```

Open http://localhost:3000 and sign in with your Google account. Check:

- **Pipeline** (`/`): only applications past Applied. Two roles at one employer are two cards (Cotiviti: Gen AI Intern and Data Scientist I). A rejection of one has not closed the other. Screening and Ghosted badges look right.
- **Applications**: the filters add up; Ghosted lists open applications quiet for 30+ days at any stage, and Rejected ones are never Ghosted.
- **Inbox**: each email shows its Application; the Screening and Staffing/recruiter filters work.
- **Review**: each item shows a recommended choice. Nothing in it was attached or closed on its own.
- **Detail** page of an Application: the timeline reads sensibly.
- **Telegram**: during steps 5 to 7 you should get no burst of messages about old mail (a single message for mail that genuinely just arrived is normal).

Overrides (change stage, split, merge, detach, answering a Review item) write to your **real** database and are saved as real labelled examples. Try one only on an Application you do not mind changing.

**Done when** nothing looks wrong. If something does, note the Application and what you expected, and give that to Claude Code.

### Step 8. Check Vercel

Vercel → the project → Settings → Environment Variables:

1. `DATABASE_URL` points at the **same database you just migrated**.
2. `SYNC_LOOKBACK_DAYS`: delete it unless you want something other than 60 (a leftover value silently beats the new default).
3. `LLM_CALLS_PER_DAY`: not set, or 1000.

### Step 9. Merge, in this order

0. **Refresh first.** Your live sync (old code) has kept storing new mail since step 2, without thread ids or extraction, and the new sync will never link such rows. Right before merging, rerun `npm run backfill:threads`, `npm run backfill` and `npm run link:history` (with `LLM_CALLS_PER_DAY` set again if the backlog is large; remove it afterwards). Then `npm run link:history -- --dry-run` must print `phase 1: 0 emails`.
1. Open [PR #17](https://github.com/harshrc1357/job-tracker/pull/17). Check the Vercel preview check is green. Merge with **Create a merge commit** (it keeps one commit per ticket). Keep the branch.
2. Open [PR #11](https://github.com/harshrc1357/job-tracker/pull/11). It now includes #17's commits. Wait for the Vercel check on the newest commit. **Only now merge it** (merge commit). This deploys.
3. Delete both branches (GitHub offers the button after each merge).
4. Update your copy: `git switch main`, `git pull`.

### Step 10. Watch the first syncs

First, once the deploy is live, run `npm run link:history -- --dry-run`. If it prints `phase 1:` above 0, mail slipped in between the refresh and the deploy: run `npm run link:history` once more.

Then read a real sync result. The main trigger is the Windows task, which appends to `sync-trigger.log` and writes `sync-last-response.json` in the repo root (both git-ignored). The GitHub Actions run ("Gmail sync" → latest run → the "Trigger job-tracker sync" step) prints the same JSON, but may print `{"ok":true,"skipped":"too-soon"}` when another trigger ran a moment before. Look at:

| Field | Expect |
|---|---|
| `errors` | `[]` |
| `inserted` | small (step 5 stored the backlog) |
| `llmCalls`, `hitLlmBudget` | well under 80 per run; `hitLlmBudget` false |
| `linked`, `needsReview` | new mail gets linked; Review stays small |
| `remindersSent` | 0, or one for a real upcoming deadline |

For the first day watch Telegram. You should get a message only for genuinely new Screening, Interview, Assessment or Offer mail. **If a burst of old mail pings you:** pause all three sync triggers (section 4, "Pausing the sync"), then tell Claude Code.

### Step 11. Close the issues

Close each with a one-line comment saying how it was verified (Claude Code can do this; see the prompt in section 9).

| Issue | Close when |
|---|---|
| #2 sync 60 days and thread id, #4 link decision function | automatically, when PR #11 merges (`Closes`) |
| #3 backfill thread ids | step 3 is done |
| #5 classifier extraction and eval | step 4a is done: comment the accuracy figures |
| #6 tables, linking during sync, Inbox link column | step 10 shows clean runs and the Inbox shows links |
| #7 Pipeline and Applications, #8 Detail overrides, #9 Review queue | step 7 checks pass |
| #10 LLM limits audit | step 6 finished and you saw how the cap behaved |
| #13 Screening, #14 Staffing/recruiter, #15 Ghosted | PR #11 is merged (the code is then in `main`) and step 4b looked right |
| #12 (spec for #13 to #15), then #1 (spec for #2 to #10) | everything under each is closed |
| #16 cleanup | later |

### Step 12 (optional). Recover recruiter mail skipped before this existed

Mail the classifier skipped under the old prompt is recorded in `ignored_messages` and is never fetched again. Step 5 already catches recruiter mail the old Gmail search never matched. This step is only for mail the old search matched and the old prompt skipped, and I would not do it unless you notice recruiter mail missing after a few weeks.

Do **not** delete those rows and let the cron re-read them: the live sync pings for every old Screening/Interview/Assessment/Offer it finds. If you do it:

1. Pause all three sync triggers (section 4, "Pausing the sync").
2. Count first, in the Supabase SQL editor: `select count(*) from ignored_messages where created_at > now() - interval '60 days';` Each row costs one LLM call to re-classify; if the count is in the thousands it is probably not worth it.
3. `delete from ignored_messages where created_at > now() - interval '60 days';`
4. `LLM_CALLS_PER_DAY=3000` in `.env`, then `npm run backfill -- --dry-run`, `npm run backfill`, `npm run link:history`.
5. Remove `LLM_CALLS_PER_DAY`, then start the sync triggers again.

---

## 5. Rollback

| Problem | Fix |
|---|---|
| The deploy misbehaves | PR #11 page → Revert → merge the revert. Vercel redeploys the old code, which runs fine on the migrated database (the migration is additive). |
| Telegram flood | Pause all three sync triggers (section 4, "Pausing the sync"), then diagnose. |
| The links look wrong and you want to start linking over | **First pause all three sync triggers** (once the new code is live, the sync also links history, 10 emails a run, and would race `link:history`). Run the SQL below, then `npm run link:history`, then start the triggers again. **It deletes every Application, including your overrides (stage, split, merge) and Review answers.** Your recorded corrections in `link_examples` stay but are not reapplied. The SQL resets the links only: what `link:history` wrote onto the emails (employer, company, role, via, round) stays, and only the step 1 backup undoes that. Tested on an in-process Postgres. |
| Anything worse | Restore the step 1 backup. |

```sql
update applications set link_state = null, job_application_id = null, link_confidence = null, link_evidence = null, link_flagged = false;
delete from review_items;
delete from job_applications;
```

Remove `LLM_CALLS_PER_DAY` from `.env` whenever you see it there.

## 6. Verification map (what proves each piece on real data)

| Behaviour | How you see it |
|---|---|
| Employer is the real company, never the ATS or sender | step 4a accuracy; Pipeline cards are named for companies |
| Reply in a known thread attaches silently | after step 3, a follow-up email lands on its Application with no Review item |
| Two roles at one employer stay two Applications; a rejection never closes the other | step 7, Cotiviti |
| Ambiguous rejection never auto-closes | it shows in Review, and the Application is still open |
| Screening moves an Application to Screening and pings Telegram | step 4b shows recruiter calls as Screening; first real recruiter mail pings you |
| Staffing/recruiter is stored, never an Application, never Review, never Telegram | Inbox → Staffing/recruiter filter; no ping |
| A Staffing/recruiter thread that turns into a Screening, Assessment, Interview or Offer becomes one Application under the agency, with the job description on its timeline | the Apex-style cases in Detail; scenario 47 |
| Ghosted: any open Application quiet 30+ days, cleared by a new email | Applications → Ghosted; badge on Pipeline cards |
| Sync is idempotent | step 10: a rerun creates no duplicates |

## 7. Decisions that are yours

1. **Telegram for an in-house recruiter's cold outreach.** It is classified Screening (your call), so it pings like an interview invite. Confirm once real mail flows; changing it is a prompt edit.
2. **An agency job description that also asks "are you available for a call?"** The prompt ranks Screening above Staffing/recruiter, so it becomes Screening: it creates an Application (agency as Employer) and sends Telegram. Step 4b shows how often that happens. If you want the job description to win, say so; it is a prompt priority change plus a test.
3. **Recovering old skipped mail** (step 12).
4. **Dark theme.** The mockups were dark; the app keeps its light theme. Colours are CSS variables in `globals.css`.

## 8. Known gaps

- Answering a Review item with "new application" does not pull in earlier job descriptions of that thread; they stay in the Inbox. Only the normal Linker adopts them.
- A Screening from an agency that names no role attaches (flagged) to the only open Application at that agency, since the agency is one Employer for all its roles (scenario 51). With two open it goes to Review.
- The live sync lists at most 500 matching messages per run and does not page; a long catch-up goes through `npm run backfill`.
- `scripts/reclassify.mts` predates this work and rewrites stored categories in place. Do not run it on linked data without a dry run and a backup.
- Linking has not been exercised at production volume. Watch Review and flagged links for the first week.
- Duplication and naming cleanups are tracked in #16.

## 9. Prompts to paste into Claude Code on your machine

Open Claude Code in the project folder on branch `claude/screening-staffing-ghosted`.

**Run the runbook with me:**

> Read `docs/HANDOFF.md` and `GLOSSARY.md`. I am on branch `claude/screening-staffing-ghosted`. We are starting at step 1 of the runbook. Do the steps with me one at a time. Stop and ask me before any command that writes to the real database (`migrate:linking`, `db:secure`, `backfill:threads`, `backfill`, `link:history`, anything with `--apply`) and show me the dry run first. Never print the contents of `.env` or any secret. After each step tell me what the doc says I should have seen and whether I did.

**After step 4, tune the prompt:**

> Here is the printed output of `eval:extraction -- --score` for the random sample and for the `--categories` run, and the ids of the category shifts I judged wrong: (paste). Use the `tdd` skill: write a failing prompt-wording or live test for each pattern first, then change `src/lib/classify/prompt.ts`. Do not touch the priority order without telling me.

**Close the verified issues:**

> Using `docs/agents/issue-tracker.md`, close issues (list) with a one-line comment each on how they were verified, per step 11 of `docs/HANDOFF.md`.

**Cleanup (#16), after both PRs are merged:**

> Pull `main`, make a new branch, and do issue #16 with the `tdd` skill. Behaviour must not change: the existing tests pass unedited and `npx tsc --noEmit` is clean. Open a PR with the `pr` skill.

## 10. Where things live

```text
src/lib/link/       decideLink (the Linker), nextState (stage rules), planLinks (batch plan, pure),
                    store (database adapter), actions (overrides, Review answers), views (page rules), types
src/lib/classify/   prompt.ts (the classifier prompt and parser), extractionEval.ts (eval scoring)
src/lib/categories.ts   categories, badge classes, and the Telegram policy (REMINDER_CATEGORIES)
src/lib/sync/       message.ts (the per-message pipeline and the Gmail search), lookback.ts
src/app/(app)/      Pipeline /, /applications, /applications/[id], /inbox, /review
scripts/            the commands in section 4; preview-db.mts serves synthetic data (npm run preview:db)
docs/               this file, linking-scenarios.md, llm-limits-audit.md, agents/ (issue tracker, labels, domain)
```

Looking at the app without real data: `npm run preview:db` serves synthetic mail from an in-process database, but the login needs Google, so you cannot click through it by hand. Ask Claude Code to start it and drive it with a signed test session. Do not start the app yourself next to a real `.env`: `npm run start` would read `DATABASE_URL` from it and connect to production.
