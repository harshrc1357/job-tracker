// Puts rows that a reclassify run moved out to ignored_messages back into
// applications, so a corrected classifier can decide them again.
//
// Written because the first run over the real inbox dropped six genuine application
// confirmations — LinkedIn's "your application was sent", Indeed's "your application
// has been submitted", an Ashby-relayed acknowledgement — on the grounds that they
// came from a job board rather than the employer. That is the dangerous direction of
// the mistake, and the reason every reclassify writes a backup first.
//
// Restores the whole notJob set rather than a hand-picked subset, on purpose. The
// classifier decides again from scratch; anything that really was an advert simply
// gets dropped a second time. Hand-picking would bake this session's judgement into
// the data, where it cannot be checked.
//
//   npx tsx scripts/restore-dropped.mts backups/reclassify-....json          # dry run
//   npx tsx scripts/restore-dropped.mts backups/reclassify-....json --apply

import fs from "node:fs";
import path from "node:path";
import { inArray } from "drizzle-orm";

loadEnv();

const { db } = await import("../src/db/client");
const { applications, ignoredMessages } = await import("../src/db/schema");

const APPLY = process.argv.includes("--apply");
const backupPath = process.argv[2];
if (!backupPath || backupPath.startsWith("--")) {
  throw new Error("usage: npx tsx scripts/restore-dropped.mts <backup.json> [--apply]");
}

type Backup = { kind: string; row: Record<string, unknown>; reason?: string }[];

const backup: Backup = JSON.parse(fs.readFileSync(backupPath, "utf8"));
const dropped = backup.filter((entry) => entry.kind === "notJob");

console.log(`${dropped.length} dropped rows in ${path.basename(backupPath)}\n`);
for (const entry of dropped) {
  console.log(`  [${entry.row.category}] ${entry.row.company}: ${String(entry.row.subject).slice(0, 60)}`);
}

if (!APPLY) {
  console.log("\ndry run — nothing written. Re-run with --apply.");
} else {
  const gmailIds = dropped.map((entry) => String(entry.row.gmailMessageId));

  // Un-bank the skip first. If the process dies between the two statements the row is
  // simply still skipped, which is the state it is already in — never a duplicate.
  await db.delete(ignoredMessages).where(inArray(ignoredMessages.gmailMessageId, gmailIds));

  const restored = await db
    .insert(applications)
    .values(
      dropped.map((entry) => ({
        gmailMessageId: String(entry.row.gmailMessageId),
        company: String(entry.row.company),
        category: String(entry.row.category),
        subject: entry.row.subject as string | null,
        snippet: entry.row.snippet as string | null,
        body: entry.row.body as string | null,
        bodyHtml: entry.row.bodyHtml as string | null,
        fromEmail: entry.row.fromEmail as string | null,
        receivedAt: new Date(String(entry.row.receivedAt)),
        // Reminder state is deliberately NOT restored. These rows are about to be
        // reclassified, and carrying a stale due date across would let a row start
        // nudging about an event that has already happened.
      }))
    )
    .onConflictDoNothing({ target: applications.gmailMessageId })
    .returning({ id: applications.id });

  console.log(`\nrestored ${restored.length} rows.`);
  console.log(`now run:\n  npx tsx scripts/reclassify.mts --apply --ids=${restored.map((r) => r.id).join(",")}`);
}

function loadEnv() {
  const envPath = path.join(process.cwd(), ".env");
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
}
