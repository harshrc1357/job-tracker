// Gives up on a message the classifier fails on every time.
//
// A failed classification is left unrecorded so the next run tries again, which is right
// for a passing fault. But anyone can send the owner an email, and one the classifier can
// never read (a body that always produces unparseable JSON, say) then costs an LLM call
// on every run for the whole lookback window, and a few of them can spend the daily cap.
// So each failure is counted, and at the limit the message is banked in ignored_messages
// like any other email that is not about a job. The run reports it, so the owner hears.
//
// Only processMessage's "classifyFailed" outcome reaches here. A rate limit or
// LlmUnavailableError never does: those say nothing about the email.

import { sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { ignoredMessages, messageFailures } from "@/db/schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PgDatabase<any, any>;

export const MAX_CLASSIFY_FAILURES = 3;

const MAX_STORED_ERROR_CHARS = 500;

export type ClassifyFailure = { messageId: string; message: string };

// Adds one failure to each message and returns the ids that reached the limit, which are
// now in ignored_messages. Sequential on purpose: the Supabase pooler stalls on queries
// pipelined down one connection (see the note in the sync route).
export async function recordClassifyFailures(
  db: Db,
  failures: readonly ClassifyFailure[]
): Promise<string[]> {
  const gaveUp: string[] = [];
  for (const failure of failures) {
    const lastError = failure.message.slice(0, MAX_STORED_ERROR_CHARS);
    const [row] = await db
      .insert(messageFailures)
      .values({ gmailMessageId: failure.messageId, failures: 1, lastError })
      .onConflictDoUpdate({
        target: messageFailures.gmailMessageId,
        set: { failures: sql`${messageFailures.failures} + 1`, lastError, updatedAt: new Date() },
      })
      .returning({ failures: messageFailures.failures });
    if (row.failures >= MAX_CLASSIFY_FAILURES) gaveUp.push(failure.messageId);
  }

  if (gaveUp.length > 0) {
    await db
      .insert(ignoredMessages)
      .values(gaveUp.map((gmailMessageId) => ({ gmailMessageId })))
      .onConflictDoNothing({ target: ignoredMessages.gmailMessageId });
  }
  return gaveUp;
}

export function gaveUpMessage(messageId: string): string {
  return `message ${messageId}: gave up after ${MAX_CLASSIFY_FAILURES} failed classifications, recorded as ignored`;
}
