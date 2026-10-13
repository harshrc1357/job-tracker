// Vocabulary follows GLOSSARY.md. The Linker is a pure function: facts in, decision out.

import type { Category } from "@/lib/categories";

export const STAGES = ["Applied", "Screening", "Assessment", "Interview", "Offer"] as const;
export type Stage = (typeof STAGES)[number];

// Set on an application when the owner overrides its stage; rebuilds then leave the stage,
// round, status and flags alone. Hidden from the flag chips on the pages.
export const MANUAL_STAGE_FLAG = "manual-stage";

// What kind of message this is, as extracted by the classifier (T4).
export type EmailKind =
  | "applied"
  | "screening"
  | "assessment"
  | "interview"
  | "offer"
  | "rejection"
  | "reminder"
  | "outreach"
  // A staffing agency's job description. Stored and shown, never an Application by itself.
  | "staffing"
  | "verification"
  | "marketing";

// The one place a classifier category becomes a kind. The sync-time linker and the rebuild
// after an override both read it, so a new category cannot be known to one and not the other.
export const KIND_BY_CATEGORY: Record<Category, EmailKind> = {
  Applied: "applied",
  Screening: "screening",
  Assessment: "assessment",
  Interview: "interview",
  Offer: "offer",
  Rejection: "rejection",
  Reminder: "reminder",
  "Staffing/recruiter": "staffing",
  Verification: "verification",
};

export type EmailFacts = {
  threadId: string | null;
  // The REAL employer, extracted from content. Never an ATS name or the sender's domain.
  employer: string | null;
  role: string | null;
  // The ATS or agency it travelled through. Metadata only; never decides the employer.
  via: string | null;
  kind: EmailKind;
  fromMe: boolean;
  receivedAt: Date;
  // Interview round when the email states one.
  round: number | null;
};

export type OpenApplication = {
  id: number;
  employer: string;
  role: string | null;
  stage: Stage;
  rejected: boolean;
  appliedAt: Date | null;
  firstSeenAt: Date;
  threadIds: readonly string[];
};

export type Candidate = { applicationId: number; score: number };

export type Decision =
  | {
      action: "attach";
      applicationId: number;
      confidence: number;
      // true for 0.70-0.89: attached, but shown on the application for the owner to glance at.
      flagged: boolean;
      // true when the email follows a rejection and so reopens the application.
      reopen: boolean;
      evidence: string;
    }
  | { action: "create"; confidence: number; flagged: boolean; evidence: string }
  | { action: "ask"; confidence: number; candidates: Candidate[]; evidence: string }
  | { action: "ignore"; evidence: string };

export type ApplicationState = {
  stage: Stage;
  round: number;
  status: "open" | "rejected";
  flags: string[];
};
