#!/usr/bin/env node
// Applies the schema changes the OpenRouter classifier needs, by hand.
//
// Not drizzle-kit push, deliberately. push diffs the whole schema and goes
// interactive the moment it finds a drift it cannot resolve on its own — here it
// offered to TRUNCATE ignored_messages (116 rows) to add a unique constraint the
// database already enforces by other means. Emptying that table would make the next
// sync re-classify every previously skipped email: 116 needless LLM calls and a
// quota wipe. Every statement below is additive and idempotent instead.
//
// Usage: node scripts/migrate-classifier.cjs

const fs = require("fs");
const path = require("path");
const { neon } = require("@neondatabase/serverless");

function loadEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
}

const STATEMENTS = [
  // Why this row got the category it did. A misclassification is otherwise
  // unfalsifiable after the fact.
  `ALTER TABLE applications ADD COLUMN IF NOT EXISTS classified_by text`,
  `ALTER TABLE applications ADD COLUMN IF NOT EXISTS classifier_evidence text`,
  // Durable half of the daily call cap. A serverless run that starts its counter at
  // zero on every invocation has no cap at all.
  `CREATE TABLE IF NOT EXISTS llm_usage (
     id serial PRIMARY KEY,
     day text NOT NULL,
     model text NOT NULL,
     calls integer NOT NULL DEFAULT 0,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  // The upsert target. Without it two overlapping runs insert two rows for the same
  // day and the cap silently doubles.
  `CREATE UNIQUE INDEX IF NOT EXISTS llm_usage_day_model ON llm_usage (day, model)`,
];

async function main() {
  loadEnv();
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  const sql = neon(process.env.DATABASE_URL);

  for (const statement of STATEMENTS) {
    await sql(statement);
    console.log("ok:", statement.split("\n")[0].trim());
  }

  const columns = await sql(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'applications' AND column_name IN ('classified_by','classifier_evidence')
     ORDER BY column_name`
  );
  const usage = await sql(`SELECT count(*)::int AS rows FROM llm_usage`);

  console.log("\napplications columns:", columns.map((c) => c.column_name).join(", "));
  console.log("llm_usage rows:", usage[0].rows);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
