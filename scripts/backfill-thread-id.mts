// Fills applications.thread_id for emails stored before the column existed. The
// application linker (src/lib/link) uses the Gmail thread as its strongest evidence, so
// history only links well once this has run.
//
// Cheap on purpose: format "minimal" returns ids only, no bodies, and no LLM is called.
// Resumable and idempotent: only rows with thread_id IS NULL are touched, so Ctrl-C and
// rerun costs nothing. Prints counts only, never message content or credentials.
//
// Usage, from the project root, after `npm run migrate:threads`:
//   npm run backfill:threads -- --dry-run
//   npm run backfill:threads

import { eq, isNull } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { applications } from "../src/db/schema.js";
import { getGmailClient } from "../src/lib/gmail.js";
import { SYNC_CONCURRENCY } from "../src/lib/constants.js";

const isDryRun = process.argv.includes("--dry-run");
const MAX_ATTEMPTS = 5;
const log = (message: string) => process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${message}\n`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Outcome = "filled" | "gone" | "failed";

async function main() {
  const rows = await db
    .select({ id: applications.id, gmailMessageId: applications.gmailMessageId })
    .from(applications)
    .where(isNull(applications.threadId));
  log(`${rows.length} emails have no thread id${isDryRun ? " (DRY RUN, nothing will be written)" : ""}`);
  if (isDryRun || rows.length === 0) return;

  const gmail = await getGmailClient();
  const tally: Record<Outcome, number> = { filled: 0, gone: 0, failed: 0 };

  async function fill(row: (typeof rows)[number]): Promise<Outcome> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await gmail.users.messages.get({
          userId: "me",
          id: row.gmailMessageId,
          format: "minimal",
        });
        if (!res.data.threadId) return "failed";
        await db.update(applications).set({ threadId: res.data.threadId }).where(eq(applications.id, row.id));
        return "filled";
      } catch (err) {
        const status = (err as { code?: number }).code;
        // Deleted from Gmail since it was stored. Nothing to recover; leave it unlinked.
        if (status === 404) return "gone";
        // Quota or transient: back off and retry. Anything else is not worth retrying.
        if (status !== 429 && (status ?? 0) < 500) return "failed";
        await sleep(1000 * 2 ** attempt);
      }
    }
    return "failed";
  }

  for (let offset = 0; offset < rows.length; offset += SYNC_CONCURRENCY) {
    const batch = rows.slice(offset, offset + SYNC_CONCURRENCY);
    for (const outcome of await Promise.all(batch.map(fill))) tally[outcome]++;
    if ((offset / SYNC_CONCURRENCY) % 25 === 0) {
      log(`${Math.min(offset + SYNC_CONCURRENCY, rows.length)}/${rows.length}  filled ${tally.filled}, gone ${tally.gone}, failed ${tally.failed}`);
    }
  }
  log(`done. filled ${tally.filled}, gone from Gmail ${tally.gone}, failed ${tally.failed} (rerun to retry failures)`);
}

main()
  .catch((err) => {
    log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
