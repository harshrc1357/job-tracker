// The owner's corrections and Review answers. Every one runs in a transaction, rebuilds
// the affected applications from their emails (so stage, dates and rounds never drift),
// and records a labelled example of what the right link was.

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { applications, jobApplications, linkExamples, reviewItems } from "@/db/schema";
import { isCategory } from "@/lib/categories";
import { nextState } from "./nextState";
import type { AppRow } from "./views";
import { MANUAL_STAGE_FLAG, STAGES, type ApplicationState, type EmailKind, type Stage } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PgDatabase<any, any>;
// Inside db.transaction the callback receives the same query surface.
type Tx = Db;

const KIND: Record<string, EmailKind> = {
  Applied: "applied", Assessment: "assessment", Interview: "interview", Offer: "offer",
  Rejection: "rejection", Reminder: "reminder", Verification: "verification",
};

function addressOf(from: string | null): string {
  const m = from?.match(/<([^>]+)>/);
  return (m ? m[1] : from ?? "").trim().toLowerCase();
}

const ownerEmail = () => process.env.OWNER_EMAIL?.trim().toLowerCase() || null;

export async function loadAppRows(db: Db): Promise<AppRow[]> {
  const apps = await db.select().from(jobApplications);
  const counts = await db
    .select({ id: applications.jobApplicationId, n: sql<number>`count(*)::int` })
    .from(applications)
    .where(eq(applications.linkState, "linked"))
    .groupBy(applications.jobApplicationId);
  const open = await db.select({ candidates: reviewItems.candidates }).from(reviewItems).where(isNull(reviewItems.resolvedAt));
  const waiting = new Set<number>();
  for (const item of open) {
    for (const c of item.candidates as { applicationId: number }[]) waiting.add(c.applicationId);
  }
  const countOf = new Map(counts.map((c) => [c.id, c.n]));
  return apps.map((a) => ({
    id: a.id,
    employer: a.employer,
    role: a.role,
    stage: (STAGES as readonly string[]).includes(a.stage) ? (a.stage as Stage) : "Applied",
    rejected: a.status === "rejected",
    interviewRound: a.interviewRound,
    flags: a.flags,
    appliedAt: a.appliedAt,
    lastActivityAt: a.lastActivityAt,
    emailCount: countOf.get(a.id) ?? 0,
    needsReview: waiting.has(a.id),
  }));
}

async function example(tx: Tx, e: typeof linkExamples.$inferInsert) {
  await tx.insert(linkExamples).values(e);
}

// Recomputes an application's stage, dates and flags from the emails linked to it, so an
// override can never leave stale aggregates. A manually set stage is respected.
async function rebuild(tx: Tx, appId: number) {
  const emails = await tx
    .select()
    .from(applications)
    .where(and(eq(applications.jobApplicationId, appId), eq(applications.linkState, "linked")))
    .orderBy(asc(applications.receivedAt), asc(applications.id));
  if (emails.length === 0) {
    await tx.delete(jobApplications).where(eq(jobApplications.id, appId));
    return;
  }
  const [app] = await tx.select().from(jobApplications).where(eq(jobApplications.id, appId));
  const owner = ownerEmail();

  let state: ApplicationState = { stage: "Applied", round: 0, status: "open", flags: [] };
  let appliedAt: Date | null = null;
  for (const e of emails) {
    const kind = isCategory(e.category) ? KIND[e.category] : "marketing";
    if (kind === "applied" && !appliedAt) appliedAt = e.receivedAt;
    if (owner && addressOf(e.fromEmail) === owner) continue;
    state = nextState(state, { kind, round: e.interviewRound });
  }

  const manual = app.flags.includes(MANUAL_STAGE_FLAG);
  await tx
    .update(jobApplications)
    .set({
      stage: manual ? app.stage : state.stage,
      interviewRound: manual ? app.interviewRound : state.round,
      status: manual ? app.status : state.status,
      flags: manual ? app.flags : state.flags,
      appliedAt,
      firstSeenAt: emails[0].receivedAt,
      lastActivityAt: emails[emails.length - 1].receivedAt,
    })
    .where(eq(jobApplications.id, appId));
}

// One conversation never straddles two applications, so a correction on one email moves
// every email of its thread that sits in the same application.
async function withThreadSiblings(tx: Tx, emailIds: readonly number[]): Promise<number[]> {
  const rows = await tx.select().from(applications).where(inArray(applications.id, [...emailIds]));
  const ids = new Set(rows.map((r) => r.id));
  for (const r of rows) {
    if (!r.threadId || r.jobApplicationId === null) continue;
    const sibs = await tx
      .select({ id: applications.id })
      .from(applications)
      .where(and(eq(applications.threadId, r.threadId), eq(applications.jobApplicationId, r.jobApplicationId)));
    for (const s of sibs) ids.add(s.id);
  }
  return [...ids];
}

const factsOf = (e: typeof applications.$inferSelect) => ({
  employer: e.company, role: e.role, threadId: e.threadId, confidence: e.linkConfidence, evidence: e.linkEvidence,
});

// "Rejected" is not a stage: it closes the application where it stands. Any stage reopens
// an application that was rejected.
export async function setStage(db: Db, appId: number, choice: Stage | "Rejected"): Promise<void> {
  await db.transaction(async (tx) => {
    const [app] = await tx.select().from(jobApplications).where(eq(jobApplications.id, appId));
    if (!app) throw new Error("application not found");
    const flags = app.flags.includes(MANUAL_STAGE_FLAG) ? app.flags : [...app.flags, MANUAL_STAGE_FLAG];
    const change = choice === "Rejected" ? { status: "rejected" } : { stage: choice, status: "open" };
    await tx.update(jobApplications).set({ ...change, flags }).where(eq(jobApplications.id, appId));
    await example(tx, { kind: "stage", toApplicationId: appId, facts: { from: app.status === "rejected" ? "Rejected" : app.stage, to: choice } });
  });
}

export async function detachEmail(db: Db, emailId: number): Promise<void> {
  await db.transaction(async (tx) => {
    const [email] = await tx.select().from(applications).where(eq(applications.id, emailId));
    if (!email || email.jobApplicationId === null) throw new Error("email is not attached to an application");
    const fromApp = email.jobApplicationId;
    const moving = await withThreadSiblings(tx, [emailId]);
    const rows = await tx.select().from(applications).where(inArray(applications.id, moving));
    for (const r of rows) {
      await tx
        .update(applications)
        .set({ linkState: "review", jobApplicationId: null, linkConfidence: 0, linkEvidence: "detached by you", linkFlagged: false })
        .where(eq(applications.id, r.id));
      await tx
        .insert(reviewItems)
        .values({ emailId: r.id, confidence: 0, evidence: "detached by you", candidates: [] })
        .onConflictDoUpdate({ target: reviewItems.emailId, set: { resolvedAt: null, evidence: "detached by you", confidence: 0, candidates: [] } });
      await example(tx, { kind: "detach", emailId: r.id, fromApplicationId: fromApp, facts: factsOf(r) });
    }
    await rebuild(tx, fromApp);
  });
}

export async function splitApplication(
  db: Db,
  appId: number,
  emailIds: readonly number[],
  opts: { role?: string | null } = {},
): Promise<number> {
  return db.transaction(async (tx) => {
    const [app] = await tx.select().from(jobApplications).where(eq(jobApplications.id, appId));
    if (!app) throw new Error("application not found");
    const moving = await withThreadSiblings(tx, emailIds);
    const rows = await tx.select().from(applications).where(and(inArray(applications.id, moving), eq(applications.jobApplicationId, appId)));
    if (rows.length === 0) throw new Error("none of those emails belong to this application");
    const [created] = await tx
      .insert(jobApplications)
      .values({
        employer: app.employer,
        role: opts.role ?? rows[rows.length - 1].role ?? null,
        firstSeenAt: rows[0].receivedAt,
        lastActivityAt: rows[rows.length - 1].receivedAt,
      })
      .returning({ id: jobApplications.id });
    await tx.update(applications).set({ jobApplicationId: created.id }).where(inArray(applications.id, rows.map((r) => r.id)));
    for (const r of rows) await example(tx, { kind: "split", emailId: r.id, fromApplicationId: appId, toApplicationId: created.id, facts: factsOf(r) });
    await rebuild(tx, created.id);
    await rebuild(tx, appId);
    return created.id;
  });
}

export async function mergeApplications(db: Db, fromId: number, intoId: number): Promise<void> {
  if (fromId === intoId) throw new Error("cannot merge an application into itself");
  await db.transaction(async (tx) => {
    const found = await tx.select().from(jobApplications).where(inArray(jobApplications.id, [fromId, intoId]));
    if (found.length !== 2) throw new Error("application not found");
    await tx.update(applications).set({ jobApplicationId: intoId }).where(eq(applications.jobApplicationId, fromId));
    await tx.delete(jobApplications).where(eq(jobApplications.id, fromId));
    await example(tx, { kind: "merge", fromApplicationId: fromId, toApplicationId: intoId, facts: {} });
    await rebuild(tx, intoId);
  });
}

export type ReviewChoice = { type: "attach"; applicationId: number } | { type: "new" } | { type: "ignore" };

export async function resolveReview(db: Db, itemId: number, choice: ReviewChoice): Promise<void> {
  await db.transaction(async (tx) => {
    const [item] = await tx.select().from(reviewItems).where(eq(reviewItems.id, itemId));
    if (!item) throw new Error("review item not found");
    if (item.resolvedAt) throw new Error("review item already resolved");
    const [email] = await tx.select().from(applications).where(eq(applications.id, item.emailId));

    let toApp: number | null = null;
    if (choice.type === "ignore") {
      await tx.update(applications).set({ linkState: "ignored", jobApplicationId: null }).where(eq(applications.id, email.id));
    } else {
      if (choice.type === "attach") {
        toApp = choice.applicationId;
      } else {
        const [created] = await tx
          .insert(jobApplications)
          .values({ employer: email.company, role: email.role, firstSeenAt: email.receivedAt, lastActivityAt: email.receivedAt })
          .returning({ id: jobApplications.id });
        toApp = created.id;
      }
      await tx
        .update(applications)
        .set({ linkState: "linked", jobApplicationId: toApp, linkConfidence: 1, linkEvidence: "confirmed by you", linkFlagged: false })
        .where(eq(applications.id, email.id));
      await rebuild(tx, toApp);
    }
    await tx.update(reviewItems).set({ resolvedAt: new Date() }).where(eq(reviewItems.id, itemId));
    await example(tx, { kind: "review", emailId: email.id, toApplicationId: toApp, facts: { ...factsOf(email), choice: choice.type } });
  });
}
