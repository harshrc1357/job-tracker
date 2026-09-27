// Standalone bulk import of a wide Gmail window. Runs in a terminal, unattended.
//
// Why this is not /api/sync: that route is a serverless function with a hard 60s
// ceiling, built to do a little work and hand the rest to the next tick. Correct for
// an incremental sync, useless for "catch up on 3,500 messages". Asking it to do both
// is what produced FUNCTION_INVOCATION_TIMEOUT.
//
// Why it is not run by an agent either: a 3,500-message pass takes far longer than
// any single agent turn, and a job that dies when its supervisor's clock runs out is
// not a background job. So this owns its own lifetime and reports through a log file.
//
// Design rules, each one the answer to a specific failure:
//
//   chunked        Work is sliced into date windows, smallest (newest) first. Each
//                  chunk commits before the next begins, so progress is durable at
//                  chunk granularity rather than all-or-nothing.
//   resumable      State lives in the database, not a checkpoint file: an id present
//                  in applications or ignored_messages is skipped. Ctrl-C and rerun
//                  costs nothing and cannot double-insert.
//   quota-aware    Stops cleanly when the durable per-day LLM cap is reached and says
//                  so, rather than grinding out failures against a spent quota.
//   line-buffered  Every line is a complete line with a timestamp. No \r progress
//                  bars: they are unreadable in a log file and hold output open.
//   isolated       One bad message is logged and stepped over. Errored messages are
//                  left unrecorded, so a rerun retries exactly those.
//
// The per-message pipeline is imported from src/lib/sync/message.ts, the same module
// /api/sync uses. A row written here is identical to a row written by the live sync.
//
// Usage, from the project root:
//   npm run backfill -- --dry-run
//   npm run backfill
//   npm run backfill:bg          (detached, logs to logs/backfill.log)

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { getGmailClient } from "../src/lib/gmail.js";
import { db } from "../src/db/client.js";
import { applications, ignoredMessages } from "../src/db/schema.js";
import { buildJobQuery, describe, processMessage } from "../src/lib/sync/message.js";
import { loadDailyUsage, ownerDayKey, recordDailyUsage } from "../src/lib/llm/dailyUsage.js";
import { getQuota, setQuota } from "../src/lib/llm/runtime.js";
import { MODEL_CHAIN } from "../src/lib/llm/models.js";
import { SYNC_CONCURRENCY } from "../src/lib/constants.js";

// Gmail caps one list page at 500. Paging matters: a 45-day window on this inbox is
// ~3,500 messages, and stopping at the cap would silently drop the oldest mail, which
// is the part a backfill exists to recover.
const PAGE_SIZE = 500;

// Days per chunk. Small enough that a chunk finishes in minutes and its work is
// committed; large enough that the Gmail list overhead is amortised.
const CHUNK_DAYS = 5;

// Rows per insert. A failure loses seconds of work, not minutes.
const WRITE_BATCH = 40;

// No per-run LLM cap here on purpose. The serverless route needs one because it must
// fit in 60s; this job's only ceiling should be the durable per-day cost control.
const NO_RUN_LIMIT = Number.MAX_SAFE_INTEGER;

// Any single Gmail or provider call that has not answered in this long is hung, not
// slow. Without this the whole job can park on one socket forever, which is precisely
// the failure mode that makes an unattended job worthless.
const CALL_TIMEOUT_MS = 90_000;

// A second concurrent run is never what anyone wants. It doubles the LLM spend on the
// same messages, both processes append to one log file and Windows refuses the second
// write, and the interleaved output is unreadable. It happened twice in practice, both
// times from pasting the run command and the watch command as a single line.
//
// So the job refuses rather than relying on the operator getting it right. The lock
// carries a pid and is treated as stale once untouched for longer than a call timeout,
// which means a killed run cannot leave the job permanently locked out.
const LOCK_PATH = "logs/backfill.lock";
const STALE_LOCK_MS = 5 * 60_000;

function acquireLock(): boolean {
  if (existsSync(LOCK_PATH)) {
    const ageMs = Date.now() - statSync(LOCK_PATH).mtimeMs;
    if (ageMs < STALE_LOCK_MS) {
      const owner = readFileSync(LOCK_PATH, "utf8").trim();
      process.stdout.write(
        `A backfill is already running (pid ${owner}, lock touched ${Math.round(ageMs / 1000)}s ago).\n` +
          `Wait for it, or stop it and delete ${LOCK_PATH}.\n`
      );
      return false;
    }
  }
  writeFileSync(LOCK_PATH, String(process.pid));
  return true;
}

function releaseLock(): void {
  try {
    rmSync(LOCK_PATH, { force: true });
  } catch {
    // A leftover lock goes stale on its own. Never worth failing the run over.
  }
}

const log = (message: string) => {
  const stamp = new Date().toISOString().slice(11, 19);
  process.stdout.write(`[${stamp}] ${message}\n`);
};

function withTimeout<T>(work: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${CALL_TIMEOUT_MS}ms`)), CALL_TIMEOUT_MS)
    ),
  ]);
}

// The window a bare `npm run backfill` covers. 30 days reaches back past the
// oldest row the previous database ever held, so it reconstructs the full history
// rather than a slice of it.
const DEFAULT_BACKFILL_DAYS = 30;

type Args = { days: number; isDryRun: boolean };

function parseArgs(argv: readonly string[]): Args {
  const raw = Number(argv.find((a) => a.startsWith("--days="))?.split("=")[1]);
  const days = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_BACKFILL_DAYS;
  return { days, isDryRun: argv.includes("--dry-run") };
}

// Newest chunk first. If the job is interrupted, what landed is the mail that matters
// most - a live interview thread beats a five-week-old rejection.
function planChunks(days: number): { newerThan: number; olderThan: number }[] {
  const chunks: { newerThan: number; olderThan: number }[] = [];
  for (let start = 0; start < days; start += CHUNK_DAYS) {
    chunks.push({ newerThan: Math.min(start + CHUNK_DAYS, days), olderThan: start });
  }
  return chunks;
}

// `newer_than:Xd older_than:Yd` bounds a chunk on both sides. older_than:0 is invalid
// in Gmail's syntax, so the newest chunk simply omits it.
function chunkQuery(newerThan: number, olderThan: number): string {
  const base = buildJobQuery(newerThan);
  return olderThan > 0 ? `${base} older_than:${olderThan}d` : base;
}

type Gmail = Awaited<ReturnType<typeof getGmailClient>>;

async function listChunkIds(gmail: Gmail, query: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  let pages = 0;

  do {
    const page = await withTimeout(
      gmail.users.messages.list({ userId: "me", q: query, maxResults: PAGE_SIZE, pageToken }),
      "gmail.messages.list"
    );
    for (const message of page.data.messages ?? []) {
      if (message.id) ids.push(message.id);
    }
    pageToken = page.data.nextPageToken ?? undefined;
    pages++;
  } while (pageToken && pages < 50);

  return ids;
}

// Wrapped in withTimeout like every other call. postgres-js runs a pool of one here,
// and if the pooler has no client slot left it queues the acquisition rather than
// refusing it — so an exhausted pool presents as an indefinite hang, not an error.
// That happened during development: abandoned runs held Supabase connections and the
// next start sat silently at this exact line for nine minutes. An unattended job must
// fail loudly instead.
// Sequential, NOT Promise.all, and that is the whole point.
//
// Supabase's transaction-mode pooler assigns a backend per transaction. postgres-js
// with max:1 pipelines two concurrent queries down one connection, and the pooler
// cannot split that pipeline across backends — so it stalls indefinitely rather than
// erroring. One query answers in ~300ms; two in a Promise.all never come back.
//
// This cost hours. It is also why /api/sync returned FUNCTION_INVOCATION_TIMEOUT on
// the very first backfill attempt: the same Promise.all pattern was there, and a 60s
// serverless ceiling turned the stall into an unexplained timeout.
//
// Two sequential round trips is ~600ms against tables this size. There was never a
// real reason to parallelise them.
async function loadSeenIds(): Promise<Set<string>> {
  const stored = await withTimeout(
    db.select({ id: applications.gmailMessageId }).from(applications),
    "loadSeenIds(applications)"
  );
  const ignored = await withTimeout(
    db.select({ id: ignoredMessages.gmailMessageId }).from(ignoredMessages),
    "loadSeenIds(ignored_messages)"
  );
  return new Set([...stored.map((r) => r.id), ...ignored.map((r) => r.id)]);
}

// True when every model in the chain has spent its day. Continuing past this point
// produces nothing but errors and a misleading error count.
function isDayQuotaSpent(usage: Record<string, number>): boolean {
  return MODEL_CHAIN.every((model) => (usage[model.id] ?? 0) >= model.requestsPerDay);
}

async function main() {
  const { days, isDryRun } = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();

  log(`Backfill starting: last ${days} days${isDryRun ? " (DRY RUN)" : ""}`);
  log(`Chunks of ${CHUNK_DAYS} days, newest first, concurrency ${SYNC_CONCURRENCY}`);

  const gmail = await withTimeout(getGmailClient(), "getGmailClient");
  log("Gmail client ready");

  const seen = await loadSeenIds();
  log(`Already in the database: ${seen.size} message ids`);

  const day = ownerDayKey();
  const usageAtStart = await loadDailyUsage(day);
  setQuota(usageAtStart);
  log(`LLM usage today (${day}): ${JSON.stringify(usageAtStart)}`);

  if (!isDryRun && isDayQuotaSpent(usageAtStart)) {
    log("Every model has spent its daily cap already. Nothing to do until tomorrow.");
    return;
  }

  const totals = { listed: 0, skipped: 0, stored: 0, ignored: 0, errors: 0, llmCalls: 0 };
  const errors: string[] = [];
  const llmBudget = { remaining: NO_RUN_LIMIT, used: 0 };

  for (const [index, chunk] of planChunks(days).entries()) {
    const label = `chunk ${index + 1} (${chunk.olderThan}-${chunk.newerThan}d ago)`;
    const ids = await listChunkIds(gmail, chunkQuery(chunk.newerThan, chunk.olderThan));
    const fresh = ids.filter((id) => !seen.has(id));
    totals.listed += ids.length;
    totals.skipped += ids.length - fresh.length;

    log(`${label}: ${ids.length} listed, ${fresh.length} new`);

    if (isDryRun || fresh.length === 0) continue;

    const pendingRows: (typeof applications.$inferInsert)[] = [];
    const pendingIgnores: string[] = [];

    const flush = async () => {
      if (pendingRows.length > 0) {
        const written = await db
          .insert(applications)
          .values(pendingRows.splice(0))
          .onConflictDoNothing({ target: applications.gmailMessageId })
          .returning({ id: applications.id });
        totals.stored += written.length;
      }
      if (pendingIgnores.length > 0) {
        await db
          .insert(ignoredMessages)
          .values(pendingIgnores.splice(0).map((gmailMessageId) => ({ gmailMessageId })))
          .onConflictDoNothing({ target: ignoredMessages.gmailMessageId });
      }
      // Flushed with the rows, not at the end. A job killed halfway must not un-spend
      // what it already spent, or the day's cap drifts high on every retry.
      const quota = getQuota();
      const deltas = quota.deltas();
      quota.clearDeltas();
      await recordDailyUsage(day, deltas).catch((err) =>
        errors.push(`usage write: ${describe(err)}`)
      );
    };

    let rateLimitedInChunk = 0;

    for (let offset = 0; offset < fresh.length; offset += SYNC_CONCURRENCY) {
      const batch = fresh.slice(offset, offset + SYNC_CONCURRENCY);
      const outcomes = await Promise.all(
        batch.map((id) =>
          withTimeout(processMessage(gmail, id, llmBudget), `processMessage ${id}`).catch(
            (err): { status: "error"; message: string } => ({
              status: "error",
              message: `message ${id}: ${describe(err)}`,
            })
          )
        )
      );

      for (const outcome of outcomes) {
        if (outcome.status === "store") pendingRows.push(outcome.values);
        else if (outcome.status === "ignore") {
          pendingIgnores.push(outcome.messageId);
          totals.ignored++;
        } else if (outcome.status === "error") {
          totals.errors++;
          if (errors.length < 50) errors.push(outcome.message);
        } else if (outcome.status === "rateLimited") {
          rateLimitedInChunk++;
          if (errors.length < 50) errors.push(outcome.message);
        }
      }

      for (const id of batch) seen.add(id);
      if (pendingRows.length + pendingIgnores.length >= WRITE_BATCH) await flush();

      const done = Math.min(offset + SYNC_CONCURRENCY, fresh.length);
      if (done % 60 === 0 || done === fresh.length) {
        log(`  ${label}: ${done}/${fresh.length} | stored ${totals.stored} | ignored ${totals.ignored} | llm ${llmBudget.used} | errors ${totals.errors}`);
      }

      // Being throttled repeatedly means waiting is cheaper than retrying. Banked
      // work is already committed, so a pause costs only time.
      if (rateLimitedInChunk >= SYNC_CONCURRENCY * 2) {
        log("  provider is rate limiting, pausing 60s");
        await new Promise((resolve) => setTimeout(resolve, 60_000));
        rateLimitedInChunk = 0;
      }
    }

    await flush();
    totals.llmCalls = llmBudget.used;
    log(`${label}: done`);

    const usageNow = await loadDailyUsage(day);
    if (isDayQuotaSpent(usageNow)) {
      log("Daily LLM cap reached. Stopping here — rerun tomorrow and it resumes from this point.");
      break;
    }
  }

  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  log("");
  log(`Finished in ${elapsed}s`);
  log(`  listed:      ${totals.listed}`);
  log(`  skipped:     ${totals.skipped} (already known)`);
  log(`  stored:      ${totals.stored}`);
  log(`  ignored:     ${totals.ignored} (not job related)`);
  log(`  LLM calls:   ${totals.llmCalls}`);
  log(`  errors:      ${totals.errors}`);

  if (errors.length > 0) {
    log(`First ${Math.min(5, errors.length)} error(s):`);
    for (const message of errors.slice(0, 5)) log(`  - ${message}`);
    log("Errored messages were left unrecorded. Rerun to retry exactly those.");
  }
}

try {
  mkdirSync("logs", { recursive: true });
} catch {
  // Only needed for the detached wrapper; a missing logs dir is not fatal here.
}

// A crash must land in the log as a crash, with a non-zero exit code, rather than as
// an unhandled rejection warning and a process that lingers. Nobody is watching.
if (!acquireLock()) process.exit(2);

// Touched between chunks so a long run never looks stale to a second starter.
const heartbeat = setInterval(() => {
  try {
    writeFileSync(LOCK_PATH, String(process.pid));
  } catch {
    // Losing one heartbeat is harmless; the next one re-touches it.
  }
}, 60_000);

try {
  await main();
} catch (err) {
  log(`FAILED: ${describe(err)}`);
  if (err instanceof Error && err.stack) log(err.stack);
  clearInterval(heartbeat);
  releaseLock();
  process.exit(1);
}

clearInterval(heartbeat);
releaseLock();
// Explicit: postgres-js keeps a pooled socket alive and would otherwise hold the
// process open after the work is done.
process.exit(0);
