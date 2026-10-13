// Adds the thread_id column the application linker needs. Additive and idempotent, and
// deliberately NOT drizzle-kit push, for the same reason as migrate-classifier.cjs: push
// diffs the whole schema and can offer destructive "fixes" for unrelated drift.
//
// Usage: node --env-file=.env scripts/migrate-thread-id.mjs
import postgres from "postgres";

const STATEMENTS = [
  `ALTER TABLE applications ADD COLUMN IF NOT EXISTS thread_id text`,
  `CREATE INDEX IF NOT EXISTS applications_thread_id_idx ON applications (thread_id)`,
];

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, connect_timeout: 15 });

try {
  for (const statement of STATEMENTS) {
    await sql.unsafe(statement);
    console.log("ok:", statement);
  }
  const [row] = await sql`SELECT count(*)::int AS total, count(thread_id)::int AS filled FROM applications`;
  console.log(`\nemails: ${row.total}, with thread_id: ${row.filled}`);
} finally {
  await sql.end();
}
