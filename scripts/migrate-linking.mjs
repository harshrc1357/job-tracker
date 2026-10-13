// Adds everything the application linker needs: the thread id and link columns on the
// email table, plus job_applications and review_items. Additive and idempotent, and
// deliberately NOT drizzle-kit push, for the same reason as migrate-classifier.cjs: push
// diffs the whole schema and can offer destructive "fixes" for unrelated drift.
//
// Back up the database (or use a Supabase branch) first. Nothing here drops or rewrites
// existing data, but it is a production schema change.
//
// Usage: npm run migrate:linking
import postgres from "postgres";
import { STATEMENTS } from "./lib/linkingStatements.mjs";


if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, connect_timeout: 15 });

try {
  for (const statement of STATEMENTS) {
    await sql.unsafe(statement);
    console.log("ok:", statement.split("\n")[0].trim());
  }
  const [row] = await sql`SELECT count(*)::int AS total, count(thread_id)::int AS with_thread FROM applications`;
  console.log(`\nemails: ${row.total}, with thread_id: ${row.with_thread}`);
  console.log("Now run: npm run db:secure   (revokes anon/authenticated grants on the new tables)");
} finally {
  await sql.end();
}
