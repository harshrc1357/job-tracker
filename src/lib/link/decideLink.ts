import { REOPENING_KINDS } from "./nextState";
import { isAtsName, normalizeEmployer, roleSimilarity } from "./normalize";
import type { Candidate, Decision, EmailFacts, EmailKind, OpenApplication } from "./types";

// A role match this close counts as the same role.
const STRONG = 0.8;
// Below this a role is treated as a different role entirely.
const WEAK = 0.5;
// Two candidates closer than this are a rival; we ask instead of guessing.
const RIVAL_GAP = 0.15;
// A fresh Applied email for the same employer + role inside this window is a duplicate
// confirmation of the same application, not a new one.
const REAPPLY_WINDOW_DAYS = 90;
const DAY_MS = 86_400_000;

// Mail that moves an application forward. If one arrives for a role we have no
// application for, the Applied email probably never reached us, so we create the card.
const PROGRESS_KINDS: readonly EmailKind[] = ["screening", "assessment", "interview", "offer"];

function strongConfidence(sim: number): number {
  return Math.min(0.99, 0.9 + ((sim - STRONG) / (1 - STRONG)) * 0.09);
}

function weakConfidence(sim: number): number {
  return Math.min(0.89, 0.7 + ((sim - WEAK) / (STRONG - WEAK)) * 0.19);
}

function attach(applicationId: number, confidence: number, evidence: string, opts: { flagged?: boolean; reopen?: boolean } = {}): Decision {
  return { action: "attach", applicationId, confidence, flagged: opts.flagged ?? false, reopen: opts.reopen ?? false, evidence };
}

function ask(confidence: number, candidates: Candidate[], evidence: string): Decision {
  return { action: "ask", confidence, candidates, evidence };
}

// Split bias: every uncertain branch below creates or asks. None guesses a merge.
export function decideLink(email: EmailFacts, apps: readonly OpenApplication[]): Decision {
  if (email.kind === "verification" || email.kind === "marketing") {
    return { action: "ignore", evidence: `${email.kind} mail never touches an application` };
  }

  const decision = decideNonTrivial(email, apps);

  // My own reply is evidence about an application that already exists. It must never
  // create one or put a question in the Review queue.
  if (email.fromMe && decision.action !== "attach") {
    return { action: "ignore", evidence: "own reply with no application to attach to" };
  }
  return decision;
}

function decideNonTrivial(email: EmailFacts, apps: readonly OpenApplication[]): Decision {
  const byThread = email.threadId ? apps.filter((a) => a.threadIds.includes(email.threadId!)) : [];
  if (byThread.length > 1) {
    return ask(0.3, byThread.map((a) => ({ applicationId: a.id, score: 1 })), "thread is claimed by several applications");
  }
  if (byThread.length === 1) {
    const [owner] = byThread;
    // Only mail that moves a process forward reopens a rejected card. A duplicate
    // Applied confirmation, a reminder or a second rejection say nothing new.
    const reopen = owner.rejected && REOPENING_KINDS.includes(email.kind);
    return attach(owner.id, 1, reopen ? "thread belongs to a rejected application; new mail reopens it" : "Gmail thread already belongs to this application", { flagged: reopen, reopen });
  }

  // ATS names are carriers, never employers (GLOSSARY: Via).
  const employer = isAtsName(email.employer) ? null : normalizeEmployer(email.employer);
  if (!employer) return ask(0.3, [], "employer could not be resolved");

  const atEmployer = apps.filter((a) => normalizeEmployer(a.employer) === employer);
  return email.kind === "applied" ? decideApplied(email, atEmployer) : decideFollowUp(email, atEmployer);
}

function scoreRoles(role: string | null, candidates: readonly OpenApplication[]): Candidate[] {
  return candidates
    .map((a) => ({ applicationId: a.id, score: roleSimilarity(role, a.role) }))
    .filter((c) => c.score >= WEAK)
    .sort((x, y) => y.score - x.score);
}

function decideApplied(email: EmailFacts, atEmployer: readonly OpenApplication[]): Decision {
  if (!email.role) {
    return { action: "create", confidence: 0.72, flagged: true, evidence: "Applied email names no role; kept separate rather than merged" };
  }
  const withinWindow = atEmployer.filter((a) => {
    const anchor = a.appliedAt ?? a.firstSeenAt;
    return Math.abs(email.receivedAt.getTime() - anchor.getTime()) <= REAPPLY_WINDOW_DAYS * DAY_MS;
  });
  const [best] = scoreRoles(email.role, withinWindow).filter((c) => c.score >= STRONG);
  if (!best) return { action: "create", confidence: 0.95, flagged: false, evidence: "no application for this employer and role in the last 90 days" };

  const match = withinWindow.find((a) => a.id === best.applicationId)!;
  if (match.rejected) {
    return { action: "create", confidence: 0.8, flagged: true, evidence: "reapplied after a rejection; treated as a new application" };
  }
  return attach(match.id, 0.95, "duplicate confirmation inside the 90-day window");
}

function decideFollowUp(email: EmailFacts, atEmployer: readonly OpenApplication[]): Decision {
  const open = atEmployer.filter((a) => !a.rejected);

  if (email.role) {
    const scored = scoreRoles(email.role, open);
    const [best, second] = scored;
    if (best && (!second || best.score - second.score >= RIVAL_GAP)) {
      if (best.score >= STRONG) return attach(best.applicationId, strongConfidence(best.score), "employer and role match");
      // A rejection closes the application, so a loose role match is not enough to act on.
      if (email.kind === "rejection") return ask(0.55, scored, "rejection matches the role only loosely; not closing anything");
      return attach(best.applicationId, weakConfidence(best.score), "employer matches, role is a weaker match", { flagged: true });
    }
    if (best && second) return ask(0.55, scored, "two roles at this employer are too close to call");

    // Nothing open matches. A rejected application with the same role is still the owner.
    const [closed] = scoreRoles(email.role, atEmployer.filter((a) => a.rejected)).filter((c) => c.score >= STRONG);
    if (closed) {
      return email.kind === "rejection"
        ? attach(closed.applicationId, strongConfidence(closed.score), "already-rejected application; repeat rejection")
        : REOPENING_KINDS.includes(email.kind)
        ? attach(closed.applicationId, 0.75, "mail for a previously rejected application; reopens it", { flagged: true, reopen: true })
        : attach(closed.applicationId, 0.75, "mail for a previously rejected application", { flagged: true });
    }
    return PROGRESS_KINDS.includes(email.kind)
      ? { action: "create", confidence: 0.75, flagged: true, evidence: "progress mail for a role with no application; Applied email likely missing" }
      : ask(0.4, [], "no application matches the role named in this email");
  }

  // No role named. Never pick between several, and never let outreach attach by guess.
  if (email.kind === "outreach") return ask(0.4, open.map((a) => ({ applicationId: a.id, score: 0 })), "outreach naming no role");
  if (open.length === 1) return attach(open[0].id, 0.8, "no role in the email; only one open application at this employer", { flagged: true });
  if (open.length > 1) return ask(0.4, open.map((a) => ({ applicationId: a.id, score: 0 })), "no role in the email and several open applications at this employer");
  return PROGRESS_KINDS.includes(email.kind)
    ? { action: "create", confidence: 0.72, flagged: true, evidence: "progress mail with no role and no application at this employer" }
    : ask(0.4, [], "no application at this employer");
}
