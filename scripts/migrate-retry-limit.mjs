// Adds message_failures, the per-message count of failed classifications that lets the
// sync give up on an email the classifier can never read (src/lib/sync/retryLimit.ts).
// Additive and idempotent, and deliberately NOT drizzle-kit push, for the same reason as
// migrate-linking.mjs. Nothing existing is dropped or rewritten.
//
// The code runs without the table too: the sync reports "retry limit: ..." in its errors
// and keeps working, it just does not count. So the order of deploy and migration does
// not matter, but run this soon after.
//
// Usage: npm run migrate:retry-limit, then npm run db:secure
import postgres from "postgres";
import { STATEMENTS } from "./lib/retryLimitStatements.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, connect_timeout: 15 });

try {
  for (const statement of STATEMENTS) {
    await sql.unsafe(statement);
    console.log("ok:", statement.split("\n")[0].trim());
  }
  const [row] = await sql`SELECT count(*)::int AS total FROM message_failures`;
  console.log(`\nmessage_failures rows: ${row.total}`);
  console.log("Now run: npm run db:secure   (revokes anon/authenticated grants on the new table)");
} finally {
  await sql.end();
}
