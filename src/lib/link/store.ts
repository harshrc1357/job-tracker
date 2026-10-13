// Applies the Linker to stored emails. Reads pending emails, runs planLinks, writes the
// result in ONE transaction, so a crash leaves either nothing linked or everything
// linked, never a half-written application.
//
// Idempotency lives in emails.link_state: only rows where it is null are processed, and
// every processed row leaves with a non-null state. Running it twice is a no-op.

import { and, asc, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { applications, jobApplications, reviewItems } from "@/db/schema";
import { isCategory, type Category } from "@/lib/categories";
import { planLinks, type LinkableEmail, type TrackedApplication } from "./planLinks";
import { STAGES, type EmailKind, type Stage } from "./types";

// Any drizzle Postgres database: postgres-js in production, PGlite in tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PgDatabase<any, any>;

export type LinkSummary = { processed: number; created: number; attached: number; review: number; ignored: number };

const KIND_BY_CATEGORY: Record<Category, EmailKind> = {
  Applied: "applied",
  Assessment: "assessment",
  Interview: "interview",
  Offer: "offer",
  Rejection: "rejection",
  Reminder: "reminder",
  Verification: "verification",
};

const DEFAULT_LIMIT = 500;

// "Name <addr@x.com>" or a bare address, compared case-insensitively.
function addressOf(from: string | null): string {
  const m = from?.match(/<([^>]+)>/);
  return (m ? m[1] : from ?? "").trim().toLowerCase();
}

export async function linkPendingEmails(
  db: Db,
  opts: {
    ownerEmail: string | null;
    limit?: number;
    // Restrict to these Gmail message ids. The live sync passes the emails it just stored,
    // so unlinked history is never swept up by it; the history script passes none.
    messageIds?: readonly string[];
    // Only mail received at or after this. The history script passes now-60d.
    since?: Date;
  },
): Promise<LinkSummary> {
  const summary: LinkSummary = { processed: 0, created: 0, attached: 0, review: 0, ignored: 0 };
  const owner = opts.ownerEmail?.trim().toLowerCase() || null;

  if (opts.messageIds?.length === 0) return summary;

  const pending = await db
    .select()
    .from(applications)
    .where(
      and(
        isNull(applications.linkState),
        opts.messageIds ? inArray(applications.gmailMessageId, [...opts.messageIds]) : undefined,
        opts.since ? gte(applications.receivedAt, opts.since) : undefined,
      ),
    )
    .orderBy(asc(applications.receivedAt), asc(applications.id))
    .limit(opts.limit ?? DEFAULT_LIMIT);
  if (pending.length === 0) return summary;

  const stored = await db.select().from(jobApplications);
  const threadRows = await db
    .select({ appId: applications.jobApplicationId, threadId: applications.threadId })
    .from(applications)
    .where(and(isNotNull(applications.jobApplicationId), isNotNull(applications.threadId)));
  const threads = new Map<number, Set<string>>();
  for (const t of threadRows) {
    if (t.appId === null || t.threadId === null) continue;
    (threads.get(t.appId) ?? threads.set(t.appId, new Set()).get(t.appId)!).add(t.threadId);
  }

  const existing: TrackedApplication[] = stored.map((a) => ({
    id: a.id,
    employer: a.employer,
    role: a.role,
    stage: (STAGES as readonly string[]).includes(a.stage) ? (a.stage as Stage) : "Applied",
    rejected: a.status === "rejected",
    appliedAt: a.appliedAt,
    firstSeenAt: a.firstSeenAt,
    threadIds: [...(threads.get(a.id) ?? [])],
    round: a.interviewRound,
    flags: a.flags,
    lastActivityAt: a.lastActivityAt,
  }));

  const emails: LinkableEmail[] = pending.map((r) => ({
    emailId: r.id,
    threadId: r.threadId,
    employer: r.company,
    role: r.role,
    via: null,
    kind: isCategory(r.category) ? KIND_BY_CATEGORY[r.category] : "marketing",
    fromMe: owner !== null && addressOf(r.fromEmail) === owner,
    receivedAt: r.receivedAt,
    round: r.interviewRound,
  }));

  const plan = planLinks(emails, existing);

  await db.transaction(async (tx) => {
    // New applications first, so emails can point at real ids.
    const realId = new Map<number, number>();
    for (const app of plan.apps.filter((a) => a.id < 0)) {
      const [row] = await tx
        .insert(jobApplications)
        .values({
          employer: app.employer,
          role: app.role,
          stage: app.stage,
          interviewRound: app.round,
          status: app.rejected ? "rejected" : "open",
          flags: app.flags,
          appliedAt: app.appliedAt,
          firstSeenAt: app.firstSeenAt,
          lastActivityAt: app.lastActivityAt,
        })
        .returning({ id: jobApplications.id });
      realId.set(app.id, row.id);
    }

    for (const app of plan.apps.filter((a) => a.id > 0 && plan.touched.has(a.id))) {
      await tx
        .update(jobApplications)
        .set({
          role: app.role,
          stage: app.stage,
          interviewRound: app.round,
          status: app.rejected ? "rejected" : "open",
          flags: app.flags,
          appliedAt: app.appliedAt,
          firstSeenAt: app.firstSeenAt,
          lastActivityAt: app.lastActivityAt,
        })
        .where(eq(jobApplications.id, app.id));
    }

    for (const r of plan.results) {
      const state = r.outcome === "created" || r.outcome === "attached" ? "linked" : r.outcome === "review" ? "review" : "ignored";
      const applicationId = r.applicationId === null ? null : r.applicationId < 0 ? realId.get(r.applicationId)! : r.applicationId;
      await tx
        .update(applications)
        .set({
          linkState: state,
          jobApplicationId: applicationId,
          linkConfidence: r.confidence,
          linkEvidence: r.evidence,
          linkFlagged: r.flagged,
        })
        .where(eq(applications.id, r.emailId));
      if (r.outcome === "review") {
        await tx
          .insert(reviewItems)
          .values({ emailId: r.emailId, confidence: r.confidence, evidence: r.evidence, candidates: r.candidates })
          .onConflictDoNothing({ target: reviewItems.emailId });
      }
      summary.processed++;
      if (r.outcome === "created") summary.created++;
      else if (r.outcome === "attached") summary.attached++;
      else if (r.outcome === "review") summary.review++;
      else summary.ignored++;
    }
  });

  return summary;
}

// Re-exported for the Review page, which counts open items for its badge.
export async function countOpenReviewItems(db: Db): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(reviewItems).where(isNull(reviewItems.resolvedAt));
  return row?.n ?? 0;
}
