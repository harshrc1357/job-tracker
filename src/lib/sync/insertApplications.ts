import type { PgDatabase } from "drizzle-orm/pg-core";
import { applications } from "@/db/schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PgDatabase<any, any>;

type NewApplication = typeof applications.$inferInsert;

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Stores a batch of synced emails and returns the ids that were newly inserted.
//
// One multi-row INSERT is fast, but Postgres refuses the WHOLE statement for one bad row.
// A throw there used to leave the route's catch block, which skipped the reminder pass,
// so a single refused email held up every reminder and kept failing the same way on each
// run. When the batch is refused, retry one row at a time: good rows are stored, the bad
// row is named in `errors`, and the caller carries on.
//
// onConflictDoNothing plus `returning` keeps this safe against two overlapping runs:
// whichever loses the race inserts nothing and gets nothing back, so only the winner
// sends the Telegram notification.
export async function insertApplications(
  db: Db,
  rows: readonly NewApplication[],
  errors: string[]
): Promise<{ gmailMessageId: string }[]> {
  const insert = (values: NewApplication[]) =>
    db
      .insert(applications)
      .values(values)
      .onConflictDoNothing({ target: applications.gmailMessageId })
      .returning({ gmailMessageId: applications.gmailMessageId });

  try {
    return await insert([...rows]);
  } catch (batchErr) {
    console.error("[sync] batch insert refused, retrying one row at a time", batchErr);
  }

  const stored: { gmailMessageId: string }[] = [];
  for (const row of rows) {
    try {
      stored.push(...(await insert([row])));
    } catch (err) {
      errors.push(`store ${row.gmailMessageId}: ${describe(err)}`);
    }
  }
  return stored;
}
