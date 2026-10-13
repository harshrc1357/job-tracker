import type { ApplicationState, EmailKind, Stage } from "./types";
import { STAGES } from "./types";

const STAGE_BY_KIND: Partial<Record<EmailKind, Stage>> = {
  applied: "Applied",
  screening: "Screening",
  assessment: "Assessment",
  interview: "Interview",
  offer: "Offer",
};

// Only these can reopen a rejected application. A late Applied confirmation, a reminder
// or a repeat rejection says nothing new about whether the employer is back in touch.
const REOPENS: readonly EmailKind[] = ["screening", "assessment", "interview", "offer"];

const rank = (stage: Stage) => STAGES.indexOf(stage);

export function nextState(
  current: ApplicationState,
  email: { kind: EmailKind; round: number | null },
): ApplicationState {
  const flags = [...current.flags];

  if (email.kind === "rejection") {
    if (current.status === "rejected") return { ...current, flags };
    if (current.stage === "Offer") flags.push("offer-rescinded");
    return { ...current, status: "rejected", flags };
  }

  let status = current.status;
  if (status === "rejected" && REOPENS.includes(email.kind)) {
    status = "open";
    flags.push("reopened");
  }

  const target = STAGE_BY_KIND[email.kind];
  const stage = target && rank(target) > rank(current.stage) ? target : current.stage;

  let round = current.round;
  if (email.kind === "interview") round = Math.max(current.round, email.round ?? 1);

  return { stage, round, status, flags };
}
