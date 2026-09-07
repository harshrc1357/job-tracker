// Re-runs the current classifier over rows that the OLD one decided.
//
// The old pipeline judged from the subject and snippet alone, so its verdicts are
// wrong in two directions and both are represented in the database:
//   - promotional mail filed into a pipeline category (rows that should not exist)
//   - assessments and interviews filed as Applied because the signal was in the body
//
// Two populations, handled differently because only one of them has the evidence:
//
//   applications      — the body is stored, so it is reclassified here, in place.
//   ignored_messages  — only the message id was kept. There is nothing to reclassify
//                       against, so those rows are deleted instead and the next sync
//                       re-fetches and re-decides them through the real pipeline.
//                       That is strictly better than a second implementation of the
//                       pipeline living in a script.
//
// Writes a full JSON backup of every affected row before touching anything.
//
//   npx tsx scripts/reclassify.ts            # dry run, prints the diff
//   npx tsx scripts/reclassify.ts --apply    # writes

import fs from "node:fs";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";

loadEnv();

const { db } = await import("../src/db/client");
const { applications, ignoredMessages } = await import("../src/db/schema");
const { classifyEmail } = await import("../src/lib/classify");
const { extractDueDate } = await import("../src/lib/extractDueDate");
const { EXTRACT_DUE_DATE_FOR } = await import("../src/lib/categories");
const { setQuota } = await import("../src/lib/llm/runtime");
const { loadDailyUsage, ownerDayKey, recordDailyUsage } = await import("../src/lib/llm/dailyUsage");

const APPLY = process.argv.includes("--apply");

// --ids=73,81 re-runs specific rows, which is how you retry the handful that failed
// without paying to reclassify the whole table again. A partial run must not touch
// the stale-skip sweep: that is a statement about the entire old population.
const idsArg = process.argv.find((arg) => arg.startsWith("--ids="));
const ONLY_IDS = idsArg
  ? idsArg.slice("--ids=".length).split(",").map((value) => Number(value.trim()))
  : null;

// The token bucket paces the provider side; this only bounds how many rows are in
// flight at once, exactly as SYNC_CONCURRENCY does in the real run.
const CONCURRENCY = 6;

type Row = typeof applications.$inferSelect;

type Change =
  | { kind: "same"; row: Row }
  | { kind: "recategorised"; row: Row; to: string; evidence: string; model: string }
  | { kind: "notJob"; row: Row; reason: string }
  | { kind: "failed"; row: Row; error: string };

async function main() {
  const day = ownerDayKey();
  const quota = setQuota(await loadDailyUsage(day));

  const rows: Row[] = ONLY_IDS
    ? await db.select().from(applications).where(inArray(applications.id, ONLY_IDS))
    : await db.select().from(applications);
  console.log(`reclassifying ${rows.length} application rows (${APPLY ? "APPLY" : "dry run"})\n`);

  const changes: Change[] = [];
  for (let offset = 0; offset < rows.length; offset += CONCURRENCY) {
    const batch = rows.slice(offset, offset + CONCURRENCY);
    changes.push(...(await Promise.all(batch.map(reclassifyRow))));
    process.stdout.write(`\r  ${Math.min(offset + CONCURRENCY, rows.length)}/${rows.length}`);
  }
  process.stdout.write("\n\n");

  report(changes);

  // Recorded whether or not --apply is set: a dry run still spends real calls, and a
  // ceiling that only counts writes is not a ceiling.
  await recordDailyUsage(day, quota.deltas());

  const backupPath = writeBackup(changes);
  console.log(`\nbackup: ${backupPath}`);

  if (!APPLY) {
    console.log("\ndry run — nothing written. Re-run with --apply.");
    return;
  }

  await applyChanges(changes);
}

async function reclassifyRow(row: Row): Promise<Change> {
  try {
    const result = await classifyEmail({
      subject: row.subject ?? "",
      from: row.fromEmail ?? "",
      // Not stored on the row. Left empty rather than guessed, which makes the
      // direct-recipient hint absent instead of wrong.
      to: "",
      cc: "",
      body: row.body ?? "",
      snippet: row.snippet ?? "",
      headers: {},
    });

    if (result.decision === "skip") return { kind: "notJob", row, reason: result.reason };
    if (result.category === row.category) return { kind: "same", row };

    return {
      kind: "recategorised",
      row,
      to: result.category,
      evidence: result.evidence,
      model: result.model,
    };
  } catch (err) {
    // Never guessed at. A row we could not reclassify keeps the category it has.
    return { kind: "failed", row, error: err instanceof Error ? err.message : String(err) };
  }
}

function report(changes: Change[]) {
  const recategorised = changes.filter((c) => c.kind === "recategorised");
  const notJob = changes.filter((c) => c.kind === "notJob");
  const failed = changes.filter((c) => c.kind === "failed");

  console.log(`unchanged:     ${changes.filter((c) => c.kind === "same").length}`);
  console.log(`recategorised: ${recategorised.length}`);
  console.log(`now not-job:   ${notJob.length}`);
  console.log(`failed:        ${failed.length}\n`);

  const moves = new Map<string, number>();
  for (const change of recategorised) {
    if (change.kind !== "recategorised") continue;
    const key = `${change.row.category} -> ${change.to}`;
    moves.set(key, (moves.get(key) ?? 0) + 1);
  }
  for (const [move, count] of [...moves].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(3)}  ${move}`);
  }

  // The rows worth eyeballing: an email that was Applied and is really an Assessment
  // or an Interview is a deadline that was silently missed.
  const promoted = recategorised.filter(
    (c) => c.kind === "recategorised" && ["Assessment", "Interview", "Offer"].includes(c.to)
  );
  if (promoted.length > 0) {
    console.log(`\nmissed actionable mail (${promoted.length}):`);
    for (const change of promoted) {
      if (change.kind !== "recategorised") continue;
      console.log(`  [${change.row.category} -> ${change.to}] ${change.row.company}: ${truncate(change.row.subject ?? "", 60)}`);
      console.log(`      evidence: ${truncate(change.evidence, 80)}`);
    }
  }

  if (failed.length > 0) {
    console.log(`\nfailed (kept their existing category):`);
    for (const change of failed.slice(0, 10)) {
      if (change.kind !== "failed") continue;
      console.log(`  ${change.row.id}: ${truncate(change.error, 100)}`);
    }
  }
}

function writeBackup(changes: Change[]): string {
  const affected = changes.filter((c) => c.kind === "recategorised" || c.kind === "notJob");
  const dir = path.join(process.cwd(), "backups");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `reclassify-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(affected, null, 2));
  return file;
}

async function applyChanges(changes: Change[]) {
  let updated = 0;
  let moved = 0;

  // Captured before anything is written, so the "old skips" set cannot accidentally
  // include the rows this run is about to add. Skipped entirely on a partial run —
  // clearing every old skip because two rows were retried would throw away decisions
  // a previous full run already made correctly.
  const staleSkipIds = ONLY_IDS
    ? []
    : (await db.select({ id: ignoredMessages.gmailMessageId }).from(ignoredMessages)).map(
        (row) => row.id
      );

  for (const change of changes) {
    if (change.kind === "recategorised") {
      // A row moving into a reminder category needs a due date or it can never nudge.
      // Only asked for when there isn't one already — it is a second paid call.
      let reminderDueAt = change.row.reminderDueAt;
      if (!reminderDueAt && (EXTRACT_DUE_DATE_FOR as string[]).includes(change.to)) {
        reminderDueAt = await extractDueDate(
          change.row.subject ?? "",
          change.row.body ?? "",
          change.row.receivedAt
        ).catch(() => null);
      }

      await db
        .update(applications)
        .set({
          category: change.to,
          classifiedBy: change.model,
          classifierEvidence: change.evidence,
          reminderDueAt,
        })
        .where(eq(applications.id, change.row.id));
      updated++;
    }
  }

  // Rows the classifier now says are not job mail: banked as ignored so they are
  // never re-fetched, then removed from the dashboard. Done in that order — if the
  // process dies between the two, the row is a duplicate, not a resurrection.
  const notJobRows = changes.flatMap((c) => (c.kind === "notJob" ? [c.row] : []));
  if (notJobRows.length > 0) {
    await db
      .insert(ignoredMessages)
      .values(notJobRows.map((row) => ({ gmailMessageId: row.gmailMessageId })))
      .onConflictDoNothing();
    await db.delete(applications).where(
      inArray(
        applications.id,
        notJobRows.map((row) => row.id)
      )
    );
    moved = notJobRows.length;
  }

  console.log(`\napplied: ${updated} recategorised, ${moved} moved out to ignored_messages`);

  // The old skips carry no body, so there is nothing to reclassify them against.
  // Dropping them makes the next sync re-fetch and re-decide each one through the
  // real pipeline, which is the only place that decision belongs.
  if (staleSkipIds.length > 0) {
    const cleared = await db
      .delete(ignoredMessages)
      .where(inArray(ignoredMessages.gmailMessageId, staleSkipIds))
      .returning({ id: ignoredMessages.gmailMessageId });
    console.log(
      `cleared ${cleared.length} old skip decisions — the next sync re-fetches and re-decides them`
    );
  }
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function loadEnv() {
  const envPath = path.join(process.cwd(), ".env");
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
}

await main();
