// Measures how well the classifier extracts employer / role / round on YOUR real mail.
// Three steps so the ground truth is yours, not the model's:
//
//   1. npm run eval:extraction -- --sample=100
//      Picks N stored emails, runs the classifier on each, and writes
//      logs/extraction-eval.json with the model's answer and EMPTY expected fields.
//      Costs about 100 LLM calls (~2 cents) and counts against the daily cap.
//      Most stored mail is Applied, so a random sample holds few recruiter calls. To judge
//      the Screening and Staffing/recruiter rules, sample the other categories instead:
//        npm run eval:extraction -- --sample=150 --categories=Interview,Assessment,Offer,Reminder
//   2. Open that file, and for each row fill "expected" (employer / role / round, null
//      where the email states none). A row with expected left null-valued as a whole
//      is skipped. Fill at least 50 for a meaningful number.
//   3. npm run eval:extraction -- --score
//      Prints per-field accuracy and the rows that were wrong, then every email whose
//      CATEGORY the current classifier would change (stored -> now), with row ids to look
//      up in the file. The category check needs no hand labels. No LLM calls.
//
// The file contains subjects and snippets of real mail. It is written under logs/, which
// is git-ignored. Do not paste it anywhere public; paste only the printed summary.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { inArray, sql } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { applications } from "../src/db/schema.js";
import { classifyEmail } from "../src/lib/classify/index.js";
import { categoryShifts, scoreExtraction, type EvalRow, type Facts } from "../src/lib/classify/extractionEval.js";
import { isCategory } from "../src/lib/categories.js";

const FILE = "logs/extraction-eval.json";
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];

type FileRow = EvalRow & { subject: string | null; from: string | null; hint: string };

async function sample(n: number, categories: string[]) {
  const rows = await db
    .select()
    .from(applications)
    .where(categories.length ? inArray(applications.category, categories) : undefined)
    .orderBy(sql`random()`)
    .limit(n);
  if (categories.length) process.stdout.write(`${rows.length} stored emails in ${categories.join(", ")}\n`);
  const out: FileRow[] = [];
  for (const [i, r] of rows.entries()) {
    const result = await classifyEmail({
      subject: r.subject ?? "",
      from: r.fromEmail ?? "",
      to: process.env.OWNER_EMAIL ?? "",
      cc: "",
      body: r.body ?? "",
      snippet: r.snippet ?? "",
      headers: {},
    }).catch(() => null);
    const predicted: Facts =
      result?.decision === "store"
        ? { employer: result.employer, role: result.role, round: result.round }
        : { employer: null, role: null, round: null };
    out.push({
      id: r.id,
      subject: r.subject,
      from: r.fromEmail,
      hint: `currently stored as company="${r.company}"${result?.decision === "store" ? `; model evidence: "${result.evidence}"` : ""}`,
      predicted,
      expected: null,
      category: { stored: r.category, predicted: result?.decision === "store" ? result.category : result ? "(skipped)" : "(error)" },
    });
    if ((i + 1) % 10 === 0) process.stdout.write(`${i + 1}/${rows.length}\n`);
  }
  mkdirSync("logs", { recursive: true });
  writeFileSync(FILE, JSON.stringify(out, null, 2));
  process.stdout.write(`Wrote ${FILE}. Fill in "expected" for each row, then run with --score.\n`);
}

function score() {
  const rows: FileRow[] = JSON.parse(readFileSync(FILE, "utf8"));
  const s = scoreExtraction(rows);
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  process.stdout.write(
    `labelled ${s.labelled}, unlabelled ${s.unlabelled}\n` +
      `employer ${pct(s.employer)}  role ${pct(s.role)}  round ${pct(s.round)}  invented roles ${s.invented}\n`
  );
  for (const w of s.wrong.slice(0, 40)) {
    process.stdout.write(`  #${w.id} ${w.field}: predicted ${JSON.stringify(w.predicted)} expected ${JSON.stringify(w.expected)}\n`);
  }
  const shifts = categoryShifts(rows);
  process.stdout.write(shifts.length ? "\ncategory the classifier would change (stored -> now), with row ids:\n" : "\nno category would change.\n");
  for (const c of shifts) process.stdout.write(`  ${c.from} -> ${c.to}: ${c.ids.length}  (ids ${c.ids.join(", ")})\n`);
}

function categoriesArg(): string[] {
  const list = (arg("categories") ?? "").split(",").map((c) => c.trim()).filter(Boolean);
  const bad = list.filter((c) => !isCategory(c));
  if (bad.length) throw new Error(`unknown category: ${bad.join(", ")}`);
  return list;
}

if (process.argv.includes("--score")) score();
else await sample(Math.min(Number(arg("sample")) || 100, 300), categoriesArg()).finally(() => process.exit());
