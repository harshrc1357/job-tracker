// Vocabulary follows GLOSSARY.md. The Linker is a pure function: facts in, decision out.

export const STAGES = ["Applied", "Screening", "Assessment", "Interview", "Offer"] as const;
export type Stage = (typeof STAGES)[number];

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
  | "verification"
  | "marketing";

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
      // true for 0.70-0.89: attached, but shown on the card for the owner to glance at.
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
