#!/usr/bin/env node
// Adds the two columns the repeating-reminder loop needs:
//   reminder_count    how many Telegram nudges have gone out for this row
//   last_reminder_at  when the last one went out, so the cron can space them 8h apart
//
// Written as raw SQL rather than `drizzle-kit push` because push on this database
// tries to rebuild the primary key and dies with 42P16 ("column id is in a primary
// key") before it ever gets to the new columns. Both statements are IF NOT EXISTS,
// so running this twice is a no-op.
//
// Usage: node scripts/migrate-reminder-cadence.cjs

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
  `ALTER TABLE applications ADD COLUMN IF NOT EXISTS reminder_count integer NOT NULL DEFAULT 0`,
  `ALTER TABLE applications ADD COLUMN IF NOT EXISTS last_reminder_at timestamp with time zone`,
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
    console.log("ok:", statement);
  }

  const columns = await sql(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'applications'
       AND column_name IN ('reminder_count', 'last_reminder_at', 'reminder_sent')
     ORDER BY column_name`
  );
  console.log(
    "reminder columns now present:",
    columns.map((row) => row.column_name).join(", ")
  );
}

main().catch((err) => {
  console.error("migration failed:", err);
  process.exit(1);
});
