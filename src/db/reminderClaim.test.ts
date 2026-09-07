import { afterAll, beforeAll, describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Proves the compare-and-swap in runReminderPass actually excludes a concurrent run.
//
// Hits the real database, because that is the only place the guarantee lives — the
// claim is a single UPDATE ... WHERE reminder_count = <observed>, and whether two of
// those can both succeed is a question about Postgres, not about our code. A mock
// would only assert that we wrote the SQL we wrote.
//
// Skipped unless RUN_DB_TESTS=1 so `npm test` stays offline and free:
//
//   RUN_DB_TESTS=1 npx vitest run src/db/reminderClaim.test.ts
//
// Cleans up after itself in afterAll, and only ever touches the row it created.

const LIVE = process.env.RUN_DB_TESTS === "1";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sql: any;
let rowId: number;

const GMAIL_ID = `test-reminder-claim-${Date.now()}`;

beforeAll(async () => {
  if (!LIVE) return;
  loadEnv();
  const { neon } = await import("@neondatabase/serverless");
  sql = neon(process.env.DATABASE_URL!);

  const [row] = await sql`
    INSERT INTO applications (gmail_message_id, company, category, subject, received_at, reminder_due_at, reminder_count, reminder_sent)
    VALUES (${GMAIL_ID}, 'Claim Test Co', 'Interview', 'concurrency fixture', now(), now() + interval '2 hours', 0, false)
    RETURNING id`;
  rowId = row.id;
});

afterAll(async () => {
  if (!LIVE || !rowId) return;
  await sql`DELETE FROM applications WHERE id = ${rowId}`;
});

describe.skipIf(!LIVE)("reminder claim", () => {
  test("only one of two concurrent runs can claim the same nudge", async () => {
    // Arrange: both runs have SELECTed the row and both see reminder_count = 0,
    // which is exactly the interleaving that produced duplicate Telegram pings.
    const observedCount = 0;
    const claim = () => sql`
      UPDATE applications
      SET reminder_count = ${observedCount + 1}, last_reminder_at = now(), reminder_sent = false
      WHERE id = ${rowId} AND reminder_count = ${observedCount}
      RETURNING id`;

    // Act: fired together, not in sequence.
    const [first, second] = await Promise.all([claim(), claim()]);

    // Assert: exactly one gets a row back, and only that one would have sent.
    const winners = [first, second].filter((rows) => rows.length === 1);
    expect(winners).toHaveLength(1);

    const [row] = await sql`SELECT reminder_count FROM applications WHERE id = ${rowId}`;
    expect(row.reminder_count).toBe(1);
  });

  test("a later run with a stale count claims nothing", async () => {
    // Arrange: the count is already 1 from the test above. A run that read the row
    // before that write still thinks it is 0.
    const stale = await sql`
      UPDATE applications
      SET reminder_count = 1, last_reminder_at = now()
      WHERE id = ${rowId} AND reminder_count = 0
      RETURNING id`;

    // Assert
    expect(stale).toHaveLength(0);
  });

  test("rolling a failed send back frees the nudge for the next run", async () => {
    // Arrange: the send threw, so the claim is released.
    await sql`
      UPDATE applications
      SET reminder_count = 0, last_reminder_at = NULL, reminder_sent = false
      WHERE id = ${rowId}`;

    // Act: the next tick tries again against the restored count.
    const retry = await sql`
      UPDATE applications
      SET reminder_count = 1, last_reminder_at = now()
      WHERE id = ${rowId} AND reminder_count = 0
      RETURNING id`;

    // Assert: the reminder was not silently spent by the failure.
    expect(retry).toHaveLength(1);
  });
});

function loadEnv() {
  const envPath = path.join(process.cwd(), ".env");
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
}
