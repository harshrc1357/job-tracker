// Builds Applications from the last 60 days of EXISTING emails. Two phases:
//
//   1. Re-extract: emails stored before the classifier returned employer / role / round
//      are re-run through it (one LLM call each) so the linker has real employers rather
//      than the old sender-based guess. Rows are only ever improved: a null answer never
//      overwrites a stored value, and the category is never changed here.
//   2. Link: runs the linker over every unlinked email, oldest first.
//
// Resumable and safe to rerun: phase 1 skips rows already extracted, phase 2 skips rows
// already linked. Stops cleanly when the durable per-day LLM cap is reached and says so.
//
// Prerequisites, in order:  npm run migrate:linking   then   npm run backfill:threads
// Usage:
//   npm run link:history -- --dry-run     counts only, no LLM calls, no writes
//   npm run link:history                  both phases
//   npm run link:history -- --days=30     narrower window

import { and, asc, eq, gte, isNull } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { applications } from "../src/db/schema.js";
import { classifyEmail } from "../src/lib/classify/index.js";
import { linkPendingEmails } from "../src/lib/link/store.js";
import { SYNC_CONCURRENCY } from "../src/lib/constants.js";
import { loadDailyUsage, ownerDayKey, recordDailyUsage } from "../src/lib/llm/dailyUsage.js";
import { getQuota, setQuota } from "../src/lib/llm/runtime.js";
import { MODEL_CHAIN } from "../src/lib/llm/models.js";
import { LlmUnavailableError } from "../src/lib/llm/errors.js";

const isDryRun = process.argv.includes("--dry-run");
const days = Number(process.argv.find((a) => a.startsWith("--days="))?.split("=")[1]) || 60;
const since = new Date(Date.now() - days * 86_400_000);
const log = (m: string) => process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${m}\n`);

async function reextract(): Promise<{ done: number; stoppedEarly: boolean }> {
  const rows = await db
    .select()
    .from(applications)
    .where(and(isNull(applications.extractedAt), gte(applications.receivedAt, since)))
    .orderBy(asc(applications.receivedAt));
  log(`phase 1: ${rows.length} emails in the last ${days} days need employer/role extraction`);
  if (isDryRun || rows.length === 0) return { done: 0, stoppedEarly: false };

  const day = ownerDayKey();
  setQuota(await loadDailyUsage(day));
  // Flushed after every batch, so a killed run does not un-spend what it spent and the
  // durable per-day cap stays honest across reruns.
  const flushUsage = async () => {
    const quota = getQuota();
    const deltas = quota.deltas();
    quota.clearDeltas();
    await recordDailyUsage(day, deltas).catch((err) => log(`usage write failed: ${String(err)}`));
  };
  let done = 0;
  let stoppedEarly = false;

  async function one(row: (typeof rows)[number]) {
    try {
      const result = await classifyEmail({
        subject: row.subject ?? "",
        from: row.fromEmail ?? "",
        to: process.env.OWNER_EMAIL ?? "",
        cc: "",
        body: row.body ?? "",
        snippet: row.snippet ?? "",
        headers: {},
      });
      const set: Partial<typeof applications.$inferInsert> = { extractedAt: new Date() };
      if (result.decision === "store") {
        if (result.employer) {
          set.employer = result.employer;
          set.company = result.employer;
        }
        if (result.via) set.via = result.via;
        if (result.role) set.role = result.role;
        if (result.round) set.interviewRound = result.round;
      }
      await db.update(applications).set(set).where(eq(applications.id, row.id));
      done++;
    } catch (err) {
      if (err instanceof LlmUnavailableError) stoppedEarly = true;
      else log(`skipped #${row.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (let i = 0; i < rows.length && !stoppedEarly; i += SYNC_CONCURRENCY) {
    await Promise.all(rows.slice(i, i + SYNC_CONCURRENCY).map(one));
    await flushUsage();
    if ((i / SYNC_CONCURRENCY) % 10 === 0) log(`  ${Math.min(i + SYNC_CONCURRENCY, rows.length)}/${rows.length}`);
  }
  if (stoppedEarly) log("stopped early: the LLM models are unavailable or today's cap is spent. Rerun later; it resumes.");
  return { done, stoppedEarly };
}

async function link() {
  const total = { processed: 0, created: 0, attached: 0, review: 0, ignored: 0 };
  for (;;) {
    const s = await linkPendingEmails(db, { ownerEmail: process.env.OWNER_EMAIL ?? null, since, limit: 200, requireExtracted: true });
    if (s.processed === 0) break;
    for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += s[k];
    log(`  linked ${total.processed} so far`);
  }
  log(`phase 2 done: ${total.created} applications created, ${total.attached} emails attached, ${total.review} need review, ${total.ignored} ignored`);
}

async function main() {
  const { stoppedEarly } = await reextract();
  if (isDryRun) {
    const pending = await db.select({ id: applications.id }).from(applications).where(and(isNull(applications.linkState), gte(applications.receivedAt, since)));
    log(`phase 2: ${pending.length} emails would be linked. Dry run: nothing written.`);
    return;
  }
  // Linking on half-extracted data would build applications from the old sender-based
  // guesses and flood Review. Wait for extraction to finish first.
  if (stoppedEarly) return log("not linking yet: finish phase 1 first.");
  await link();
}

main()
  .catch((err) => {
    log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
