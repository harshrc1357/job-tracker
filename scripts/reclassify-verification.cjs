#!/usr/bin/env node
// One-off backfill: rows synced before the Verification category existed were
// filed as Applied/Reminder/etc. This re-tests each stored subject + snippet
// against the Verification keyword rules and moves only the matches over.
//
// Deliberately one-directional — it never moves a row OUT of Verification, and
// never touches a row that does not match. Worst case it is a no-op.
//
// Run with --dry to see what would change without writing.
// Usage: node scripts/reclassify-verification.cjs [--dry]

const fs = require("fs");
const path = require("path");

// Kept in step with the Verification block in src/lib/classify.ts. Duplicated
// rather than imported because this is a plain-node throwaway and importing the
// TS module would mean fighting the "@/" path alias for one run.
const VERIFICATION_PATTERNS = [
  /\b(one[- ]?time (password|passcode|code))\b/i,
  /\botp\b/i,
  /verification code/i,
  /security code/i,
  /confirmation code/i,
  /access code/i,
  /verify your (email|account|address|identity)/i,
  /confirm your (email|account|address)/i,
  /email verification/i,
  /two[- ]?factor/i,
  /\b2fa\b/i,
  /magic link/i,
  /(reset|change) your password/i,
  /\bis your .{0,20}code\b/i,
  /\bcode is\b[:\s]*\d{4,8}/i,
];

function loadEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) process.env[match[1]] = match[2].replace(/^"|"$/g, "");
  }
}

function isVerification(subject, snippet) {
  const text = `${subject ?? ""}\n${snippet ?? ""}`;
  return VERIFICATION_PATTERNS.some((pattern) => pattern.test(text));
}

async function main() {
  const isDryRun = process.argv.includes("--dry");
  loadEnv();
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set in .env");
    process.exit(1);
  }

  const { neon } = require("@neondatabase/serverless");
  const sql = neon(process.env.DATABASE_URL);

  const rows = await sql(
    `SELECT id, company, category, subject, snippet FROM applications
     WHERE category <> 'Verification'`
  );

  const matches = rows.filter((row) => isVerification(row.subject, row.snippet));
  console.log(`scanned ${rows.length} rows, ${matches.length} look like Verification`);

  for (const row of matches) {
    console.log(`  ${row.category} -> Verification | ${row.company} | ${row.subject}`);
  }

  if (isDryRun) {
    console.log("dry run, nothing written");
    return;
  }

  for (const row of matches) {
    // Moving to Verification also clears any pending reminder state: that category
    // never nudges, so leaving a due date behind would be a reminder waiting to fire.
    await sql(
      `UPDATE applications
       SET category = 'Verification', reminder_due_at = NULL, reminder_sent = true
       WHERE id = $1`,
      [row.id]
    );
  }
  console.log(`updated ${matches.length} rows`);
}

main().catch((err) => {
  console.error("reclassify failed:", err);
  process.exit(1);
});
