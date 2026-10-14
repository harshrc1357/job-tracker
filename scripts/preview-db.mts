// Starts an in-memory Postgres (PGlite) on a local port, creates the schema and fills it
// with SYNTHETIC mail, then runs the linker over it. Lets you click through Pipeline,
// Applications, Inbox, Detail and Review with no real data and no secrets.
//
//   npm run preview:db            (leave running)
//   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/postgres \
//   SESSION_SECRET=dev OWNER_EMAIL=me@example.com npm run dev
//
// Nothing here touches your real database: it never reads DATABASE_URL.

import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { drizzle } from "drizzle-orm/pglite";
import { createRequire } from "node:module";
import * as schema from "../src/db/schema.js";
import { applications } from "../src/db/schema.js";
import { linkPendingEmails } from "../src/lib/link/store.js";

const { pushSchema } = createRequire(import.meta.url)("drizzle-kit/api") as typeof import("drizzle-kit/api");
const port = Number(process.env.PREVIEW_DB_PORT) || 5433;

const pg = new PGlite();
const db = drizzle(pg, { schema });
await (await pushSchema(schema, db as never)).apply();

const day = (n: number) => new Date(Date.UTC(2026, 8, 1 + n, 14));
type Seed = { c: string; role: string | null; cat: string; d: number; subj: string; from?: string; thread?: string; round?: number };
const seeds: Seed[] = [
  { c: "Cotiviti", role: "Intern - Gen AI Research Engineer", cat: "Applied", d: 11, subj: "We've received your application", thread: "cot-gen" },
  { c: "Cotiviti", role: "Intern - Gen AI Research Engineer", cat: "Assessment", d: 21, subj: "Screening questionnaire completed", thread: "cot-gen" },
  { c: "Cotiviti", role: null, cat: "Interview", d: 28, subj: "Interview round 1: recruiter call", from: "Meghan Dynan <meghan@icims.com>", thread: "cot-gen", round: 1 },
  { c: "Cotiviti", role: null, cat: "Interview", d: 30, subj: "Your Cotiviti interview for the Intern - Gen AI Research Engineer", thread: "cot-gen", round: 2 },
  { c: "Cotiviti", role: "Data Scientist I - AI/ML", cat: "Applied", d: 19, subj: "Application received: Data Scientist I", thread: "cot-ds" },
  { c: "Cotiviti", role: "Data Scientist I - AI/ML", cat: "Rejection", d: 37, subj: "Update on your application", thread: "cot-ds" },
  { c: "Snowflake", role: "AI/ML SWE Intern - Spring 2027", cat: "Applied", d: 27, subj: "Thanks for applying", thread: "sf-1" },
  { c: "Snowflake", role: "AI/ML SWE Intern - Spring 2027", cat: "Assessment", d: 35, subj: "Thanks for taking the [Spring 2027] AI/ML SWE Intern Coding Test", thread: "sf-1" },
  { c: "Snowflake", role: "SWE Intern - Core Eng / Security", cat: "Applied", d: 28, subj: "Thanks for applying", thread: "sf-2" },
  { c: "Snowflake", role: "SWE Intern - Core Eng / Security", cat: "Assessment", d: 36, subj: "Invitation: complete your assessment", thread: "sf-2-b" },
  { c: "Ember", role: "Ember Fellowship", cat: "Applied", d: 30, subj: "Application received", thread: "em-1" },
  { c: "Ember", role: "Ember Fellowship", cat: "Interview", d: 35, subj: "Video interview invitation", thread: "em-1" },
  { c: "Thales Group", role: "Security AI Ops Engineer", cat: "Applied", d: 32, subj: "Your application to Security AI Ops Engineer", thread: "th-1" },
  { c: "Thales Group", role: "Security AI Ops Engineer", cat: "Assessment", d: 38, subj: "Your Screening for Security AI Ops Engineer has been submitted", thread: "th-1" },
  { c: "Roblox", role: "SWE Intern 2027", cat: "Applied", d: 14, subj: "Thanks for applying to Roblox" },
  { c: "Roblox", role: "ML Engineer Intern", cat: "Applied", d: 14, subj: "Thanks for applying to Roblox" },
  { c: "Roblox", role: null, cat: "Reminder", d: 40, subj: "Are you still interested in a position at Roblox?" },
  { c: "Insight Global", role: "Data Engineer", cat: "Applied", d: 1, subj: "Application received" },
  { c: "Month2Month", role: null, cat: "Applied", d: 36, subj: "Application received" },
  // A staffing agency's job description whose thread later becomes a recruiter screen: the
  // Application is created under the agency and the job description joins its timeline.
  { c: "Apex Systems", role: "Data Engineer", cat: "Staffing/recruiter", d: 20, subj: "Data Engineer - job description (hybrid)", thread: "ap-1", from: "Dana Lee <dana@apexsystems.example>" },
  { c: "Apex Systems", role: "Data Engineer", cat: "Screening", d: 23, subj: "Quick phone screen with the client?", thread: "ap-1", from: "Dana Lee <dana@apexsystems.example>" },
  // A job description whose thread never converts: stays in the Inbox, nowhere else.
  { c: "Robert Half", role: "BI Developer", cat: "Staffing/recruiter", d: 30, subj: "BI Developer - job description", thread: "rh-1" },
  // An in-house recruiter writing personally, no Applied email first.
  { c: "Magpie Health Analytics", role: "Data Analyst", cat: "Screening", d: 38, subj: "Intro call about our Data Analyst role", from: "Sam Ortiz <sam@magpiehealth.example>" },
  // A recent Screening after an Applied email.
  { c: "Juniper Square", role: "Applied AI Engineer", cat: "Applied", d: 36, subj: "Thank you for submitting your application", thread: "js-1" },
  { c: "Juniper Square", role: "Applied AI Engineer", cat: "Screening", d: 40, subj: "Can we find 20 minutes this week?", thread: "js-1" },
  // Got past Applied, then went quiet: Ghosted now covers it.
  { c: "Northwind", role: "Backend Engineer", cat: "Applied", d: 2, subj: "Application received", thread: "nw-1" },
  { c: "Northwind", role: "Backend Engineer", cat: "Interview", d: 6, subj: "Interview round 1", thread: "nw-1", round: 1 },
];
// Plus a spread of quiet Applied-only applications so Ghosted 30d+ has something to show.
for (let i = 0; i < 12; i++) seeds.push({ c: `Quiet Co ${i + 1}`, role: "Software Engineer", cat: "Applied", d: i, subj: "Thanks for applying" });

let n = 0;
for (const s of seeds) {
  n++;
  await db.insert(applications).values({
    gmailMessageId: `seed${n}`, threadId: s.thread ?? null, company: s.c, employer: s.c, role: s.role, category: s.cat,
    subject: s.subj, snippet: s.subj, body: `${s.subj}\n\n(synthetic preview data)`, fromEmail: s.from ?? `careers@${s.c.toLowerCase().replace(/\W/g, "")}.example`,
    receivedAt: day(s.d), interviewRound: s.round ?? null, extractedAt: new Date(),
  });
}
const summary = await linkPendingEmails(db as never, { ownerEmail: "me@example.com" });
console.log("seeded", n, "emails ->", summary);

const server = new PGLiteSocketServer({ db: pg, port, host: "127.0.0.1" });
await server.start();
console.log(`preview database listening: postgres://postgres:postgres@127.0.0.1:${port}/postgres`);
