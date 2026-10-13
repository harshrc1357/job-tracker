// Runs the Linker over a batch of emails and says what should change, without touching
// a database. The DB adapter (store.ts) applies the plan; keeping the two apart is what
// lets "30 applications in one run" and "same mail twice" be tested without a network.

import { PROGRESS_KINDS, decideLink } from "./decideLink";
import { nextState } from "./nextState";
import type { ApplicationState, Candidate, EmailFacts, OpenApplication } from "./types";

export type TrackedApplication = Omit<OpenApplication, "threadIds"> & {
  threadIds: string[];
  via: string | null;
  round: number;
  flags: string[];
  lastActivityAt: Date;
};

export type LinkableEmail = EmailFacts & { emailId: number };

// A staffing agency's job description stored earlier and left unlinked, waiting for its
// Gmail thread to turn into an Application.
export type WaitingJobDescription = { emailId: number; threadId: string; receivedAt: Date };

export type LinkResult = {
  emailId: number;
  outcome: "attached" | "created" | "review" | "ignored";
  // Negative for an application created in this plan; the adapter swaps in the real id.
  applicationId: number | null;
  confidence: number;
  flagged: boolean;
  evidence: string;
  candidates: Candidate[];
};

export type LinkPlan = {
  // Every application after the plan: stored ones (some modified) plus new ones.
  apps: TrackedApplication[];
  results: LinkResult[];
  // Ids of stored applications that changed, and all new ones. Only these are written.
  touched: Set<number>;
};

const stateOf = (a: TrackedApplication): ApplicationState => ({
  stage: a.stage,
  round: a.round,
  status: a.rejected ? "rejected" : "open",
  flags: a.flags,
});

const later = (a: Date, b: Date) => (a.getTime() >= b.getTime() ? a : b);
const earlier = (a: Date, b: Date) => (a.getTime() <= b.getTime() ? a : b);

export function planLinks(
  emails: readonly LinkableEmail[],
  existing: readonly TrackedApplication[],
  waitingJobDescriptions: readonly WaitingJobDescription[] = [],
): LinkPlan {
  const apps: TrackedApplication[] = existing.map((a) => ({ ...a, threadIds: [...a.threadIds], flags: [...a.flags] }));
  const results: LinkResult[] = [];
  const touched = new Set<number>();
  let nextTempId = -1;

  // Job descriptions by Gmail thread. `at` is the index of an ignored result in this plan
  // that has to be rewritten; stored ones have none and get a new result instead.
  type Waiting = { emailId: number; receivedAt: Date; at?: number };
  const waiting = new Map<string, Waiting[]>();
  const wait = (threadId: string, item: Waiting) => waiting.set(threadId, [...(waiting.get(threadId) ?? []), item]);
  for (const jd of waitingJobDescriptions) wait(jd.threadId, { emailId: jd.emailId, receivedAt: jd.receivedAt });

  // The thread has become an Application, so the job descriptions sent earlier in it belong
  // on its timeline. Adopting changes neither the stage nor the last-activity date.
  const adopt = (email: LinkableEmail, app: TrackedApplication) => {
    if (email.fromMe || !email.threadId || !PROGRESS_KINDS.includes(email.kind)) return;
    for (const jd of waiting.get(email.threadId) ?? []) {
      const result: LinkResult = {
        emailId: jd.emailId, outcome: "attached", applicationId: app.id, confidence: 1, flagged: false,
        evidence: "job description sent earlier in the same Gmail thread", candidates: [],
      };
      if (jd.at === undefined) results.push(result);
      else results[jd.at] = result;
      app.firstSeenAt = earlier(app.firstSeenAt, jd.receivedAt);
      app.lastActivityAt = later(app.lastActivityAt, jd.receivedAt);
    }
    waiting.delete(email.threadId);
    touched.add(app.id);
  };

  // Time order is part of the contract. Whether a later email counts as a duplicate,
  // a reopen or a new application depends on what had already happened by then.
  const ordered = [...emails].sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime() || a.emailId - b.emailId);

  for (const email of ordered) {
    const decision = decideLink(email, apps);
    const base = { emailId: email.emailId, candidates: [] as Candidate[] };

    if (decision.action === "ignore") {
      if (email.kind === "staffing" && email.threadId) wait(email.threadId, { emailId: email.emailId, receivedAt: email.receivedAt, at: results.length });
      results.push({ ...base, outcome: "ignored", applicationId: null, confidence: 0, flagged: false, evidence: decision.evidence });
      continue;
    }

    if (decision.action === "ask") {
      results.push({ ...base, outcome: "review", applicationId: null, confidence: decision.confidence, flagged: false, evidence: decision.evidence, candidates: decision.candidates });
      continue;
    }

    if (decision.action === "create") {
      const state = nextState({ stage: "Applied", round: 0, status: "open", flags: [] }, email);
      const created: TrackedApplication = {
        id: nextTempId--,
        employer: email.employer ?? "Unknown",
        role: email.role,
        stage: state.stage,
        rejected: state.status === "rejected",
        appliedAt: email.kind === "applied" ? email.receivedAt : null,
        firstSeenAt: email.receivedAt,
        threadIds: email.threadId ? [email.threadId] : [],
        via: email.via,
        round: state.round,
        flags: state.flags,
        lastActivityAt: email.receivedAt,
      };
      apps.push(created);
      touched.add(created.id);
      results.push({ ...base, outcome: "created", applicationId: created.id, confidence: decision.confidence, flagged: decision.flagged, evidence: decision.evidence });
      adopt(email, created);
      continue;
    }

    const app = apps.find((a) => a.id === decision.applicationId)!;
    // My own reply is evidence that the thread exists, never that the process moved.
    if (!email.fromMe) {
      const state = nextState(stateOf(app), email);
      app.stage = state.stage;
      app.round = state.round;
      app.rejected = state.status === "rejected";
      app.flags = state.flags;
      if (email.kind === "applied") app.appliedAt = app.appliedAt ? earlier(app.appliedAt, email.receivedAt) : email.receivedAt;
    }
    if (email.threadId && !app.threadIds.includes(email.threadId)) app.threadIds.push(email.threadId);
    if (!app.role && email.role) app.role = email.role;
    if (!app.via && email.via) app.via = email.via;
    app.firstSeenAt = earlier(app.firstSeenAt, email.receivedAt);
    app.lastActivityAt = later(app.lastActivityAt, email.receivedAt);
    touched.add(app.id);
    results.push({ ...base, outcome: "attached", applicationId: app.id, confidence: decision.confidence, flagged: decision.flagged, evidence: decision.evidence });
    adopt(email, app);
  }

  return { apps, results, touched };
}
