#!/usr/bin/env node
// Creates the ignored_messages table: gmail message ids the classifier has already
// judged not job-related.
//
// Without it, every non-job email inside the 14-day lookback window was re-fetched
// and re-classified on every run — 323 LLM calls per run against a free tier of 250
// per day. The quota was permanently exhausted, so real job mail stopped being
// classified at all.
//
// Raw SQL rather than `drizzle-kit push`, which fails on this database with 42P16
// ("column id is in a primary key") before it reaches any new table. IF NOT EXISTS
// throughout, so running twice is a no-op.
//
// Usage: node scripts/migrate-ignored-messages.cjs

const fs = require("fs");
const path = require("path");

function loadEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) process.env[match[1]] = match[2].replace(/^"|"$/g, "");
  }
}

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS ignored_messages (
     id serial PRIMARY KEY,
     gmail_message_id text NOT NULL UNIQUE,
     created_at timestamp with time zone NOT NULL DEFAULT now()
   )`,
  // The sync loads every id on each run and looks them up as a Set, but the unique
  // constraint's index is what keeps onConflictDoNothing cheap as this grows.
  `CREATE INDEX IF NOT EXISTS ignored_messages_gmail_message_id_idx
     ON ignored_messages (gmail_message_id)`,
];

async function main() {
  loadEnv();
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set in .env");
    process.exit(1);
  }

  const { neon } = require("@neondatabase/serverless");
  const sql = neon(process.env.DATABASE_URL);

  for (const statement of STATEMENTS) {
    await sql(statement);
    console.log("ok:", statement.split("\n")[0].trim());
  }

  const [{ count }] = await sql(`SELECT count(*)::int AS count FROM ignored_messages`);
  console.log(`ignored_messages ready, ${count} row(s)`);
}

main().catch((err) => {
  console.error("migration failed:", err);
  process.exit(1);
});
