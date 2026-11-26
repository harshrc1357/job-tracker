# Job Tracker

A single-user web app that turns job-related Gmail into a view of your applications. It reads
your mail (read-only), classifies each message with an LLM, groups messages into Applications,
and sends Telegram reminders for the ones that need action.

It is built for one owner. It is not a hosted service and does not accept other users.

## Screenshots

All companies, people and emails in these images are invented.

**Pipeline:** each active Application and the stage it reached.

![Pipeline screen with one card for each active Application and its stage](docs/images/pipeline.png)

**Applications:** every Application, with filters.

![Applications screen with a table of employers, roles, stages and dates](docs/images/applications.png)

**Inbox:** a count for each category, and the emails themselves.

![Inbox screen with category counts, a list of emails and one open email](docs/images/inbox.png)

## What it does

- **Syncs** recent job-related mail from Gmail (the last 60 days by default).
- **Filters** job alerts and other noise before any model call.
- **Classifies** each remaining message: Applied, Screening, Assessment, Interview, Offer,
  Rejection, Reminder, Staffing/recruiter or Verification.
- **Links** messages into Applications (one Role at one Employer). When it is unsure, it asks
  you in a Review queue instead of guessing.
- **Reminds** you on Telegram about Screening, Assessment, Interview and Offer mail, and again
  as a due date gets close.
- **Shows** a Pipeline, an Applications list with a "Ghosted" filter (no mail for 30+ days),
  an Inbox, a timeline for each Application and the Review queue.

The words used here (Application, Employer, Via, Linker, Ghosted) are defined in
[GLOSSARY.md](GLOSSARY.md). The cases the Linker handles are in
[docs/linking-scenarios.md](docs/linking-scenarios.md).

## How it works

```text
Gmail (read-only)
  -> prefilter (no model call)
  -> classifier (OpenRouter: Gemini, with a GPT fallback)
  -> Postgres
  -> Linker (Thread -> Employer + Role -> Employer -> ask)
  -> dashboard and Telegram
```

A scheduler calls `/api/sync`. The dashboard is behind "Sign in with Google" and admits one
email address, `OWNER_EMAIL`.

**Stack:** Next.js (App Router), React, TypeScript, Drizzle ORM, Postgres, Vitest.

## Try the tests

No database, keys or accounts are needed. The tests run an in-process Postgres on invented data.

```bash
npm ci
npm test
npm run typecheck
```

To work on the screens without a real database, run `npm run preview:db`. It starts a
temporary local database with invented mail. In `.env`, set `DATABASE_URL` to
`postgres://postgres:postgres@127.0.0.1:5433/postgres`. The dashboard still asks you to sign
in, so you also need the Google settings from the next section.

## Run your own

You need a Postgres database, a Google Cloud OAuth client, an OpenRouter key and a Telegram bot.

1. **Google Cloud.** Enable the Gmail API. Create an OAuth client of type "Web application".
   Add the four redirect URIs listed in [.env.example](.env.example).
2. **Environment.** Copy `.env.example` to `.env` and fill it in. Each variable is explained
   there. Set `OWNER_TIME_ZONE` too if you are not in `America/Chicago`.
3. **Database.** With `DATABASE_URL` set in your shell, run `npm run db:push`. If you use
   Supabase, then run `npm run db:secure` and check it with `npm run db:secure:check`.
   Supabase exposes new tables through its public API until you lock them.
4. **Start.** Run `npm run dev`, sign in, then open `/api/auth/google` once to connect Gmail.
5. **Deploy.** The app runs on Vercel. Add the same variables to the project, with your
   production redirect URIs.
6. **Schedule the sync.** Change the URL in [.github/workflows/sync.yml](.github/workflows/sync.yml)
   to your deployment, and add a `CRON_SECRET` Actions secret. GitHub often delays scheduled
   runs by hours. On Windows, [scripts/register-sync-task.ps1](scripts/register-sync-task.ps1)
   registers a task that calls the sync every 5 minutes (set the URL in
   [scripts/trigger-sync.ps1](scripts/trigger-sync.ps1) first).

## Security and privacy

- Gmail access is read-only. The Gmail refresh token is stored encrypted (AES-256-GCM).
- The sender, recipients, subject and part of the body of each classified message are sent to
  OpenRouter. The [privacy page](src/app/privacy/page.tsx) states what is read, sent and stored.
- Email HTML is sanitised when it is stored and shown in a sandboxed frame.
- `/api/sync` is public on purpose. It runs at most once every few minutes, and a caller without
  `CRON_SECRET` gets only `{"ok":true}`.

Never commit `.env`, a database dump or a mail export. `.gitignore` already excludes them.

## About this repository

The public history starts from a clean snapshot. Names of people and companies in test data
and examples are invented. The exceptions are the job platforms and tools that the app
recognises, and a few well-known companies that test name aliases.

## License

[MIT](LICENSE).
