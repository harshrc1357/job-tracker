// Two stages, in this order, and the order is the whole design.
//
//   1. prefilter  — free, deterministic, and only ever REJECTS. It throws away bulk
//                   job advertising that cannot possibly be a reply about his own
//                   application. It never assigns a category.
//   2. LLM        — reads From/To/Subject and the whole body, decides job-vs-not
//                   first and stage second.
//
// What used to sit between them was a keyword table that assigned a category from
// the subject and snippet alone, and skipped the LLM entirely when it matched. It is
// gone, deliberately. It was the direct cause of the two worst failures this
// classifier had:
//
//   - "Thank you for your application" matched the Applied rule and returned before
//     anything read the body, so the assessment link and deadline further down were
//     never seen. Losing those is the failure this whole tool exists to prevent.
//   - Promotional mail that happened to contain "interview" or "assessment"
//     boilerplate was filed straight into a pipeline category, because a regex has no
//     way to ask whether the email is about an application he actually made.
//
// A regex over a subject line cannot answer either question. Both are now the model's
// job, on the full body, every time. At roughly $0.00015 an email that is a trade
// worth making many times over.

import { complete } from "@/lib/llm/complete";
import { CLASSIFIER_MAX_TOKENS, CLASSIFIER_SYSTEM_PROMPT, parseVerdict } from "./prompt";
import {
  buildClassifierInput,
  isDirectRecipient,
  statesOwnApplication,
  type EmailForClassification,
} from "./emailInput";
import { prefilter, type PrefilterInput } from "./prefilter";
import type { Category } from "@/lib/categories";

export type ClassifiableEmail = {
  subject: string;
  from: string;
  to: string;
  cc: string;
  body: string;
  snippet: string;
  // Lowercased header name -> value. Only the bulk-mail headers are read.
  headers: Record<string, string>;
};

// Lets the caller cap how many LLM calls a run makes, without the caller having to
// know which emails will need one. Reserved only after the free prefilter has had its
// say, so bulk advertising costs nothing against the budget.
//
// It did before, and the effect was not subtle: a run reported hitting an 80-call
// budget after 26 real calls, because the other 54 messages were rejected for free
// and charged anyway. The backlog drained at a third of the rate it should have, and
// the Telegram alert blamed a quota that had not been touched.
export type ClassifierBudget = {
  // Returns false when the run is out of allowance. Consumes one when it returns true.
  tryReserve: () => boolean;
};

export type Classification =
  // Needs an LLM call and the caller's budget is spent. Nothing was decided and
  // nothing must be recorded — the next run picks it up.
  | { decision: "deferred" }
  // Not part of his pipeline. Safe to bank in ignored_messages and never look at again.
  | { decision: "skip"; reason: string; source: "prefilter" | "llm" }
  // Store it under this category.
  | {
      decision: "store";
      category: Category;
      // The words from the email that decided it. Cheap to log, and the fastest way
      // to tell a prompt regression from a genuinely ambiguous email.
      evidence: string;
      model: string;
      usedFallback: boolean;
    };

// Throws LlmUnavailableError (or LlmError) when the models cannot be reached or
// cannot be understood. That is not a skip and must never be recorded as one — the
// caller leaves the message unrecorded so the next run retries it.
export async function classifyEmail(
  email: ClassifiableEmail,
  budget?: ClassifierBudget
): Promise<Classification> {
  const verdictFromPrefilter = prefilter(toPrefilterInput(email));
  if (verdictFromPrefilter.decision === "reject") {
    return { decision: "skip", reason: verdictFromPrefilter.reason, source: "prefilter" };
  }

  // Reserved here and not a line earlier. Everything above this point is free.
  if (budget && !budget.tryReserve()) return { decision: "deferred" };

  const input = buildClassifierInput(
    toClassifierEmail(email, verdictFromPrefilter.bulkSignals)
  );

  const response = await complete({
    system: CLASSIFIER_SYSTEM_PROMPT,
    user: input,
    maxTokens: CLASSIFIER_MAX_TOKENS,
    json: true,
  });

  const verdict = parseVerdict(response.content, response.model);
  if (!verdict.isJob) {
    return { decision: "skip", reason: verdict.reason, source: "llm" };
  }

  return {
    decision: "store",
    category: verdict.category,
    evidence: verdict.evidence,
    model: response.model,
    usedFallback: response.usedFallback,
  };
}

function toPrefilterInput(email: ClassifiableEmail): PrefilterInput {
  return {
    subject: email.subject,
    from: email.from,
    body: email.body || email.snippet,
    headers: email.headers,
  };
}

function toClassifierEmail(
  email: ClassifiableEmail,
  bulkSignals: readonly string[]
): EmailForClassification {
  const base = {
    subject: email.subject,
    from: email.from,
    to: email.to,
    cc: email.cc,
    body: email.body,
    snippet: email.snippet,
    bulkSignals,
    directRecipient: null,
    ownApplicationSubject: statesOwnApplication(email.subject),
  };

  const ownerEmail = process.env.OWNER_EMAIL ?? "";
  return {
    ...base,
    directRecipient: ownerEmail ? isDirectRecipient(base, ownerEmail) : null,
  };
}

export { prefilter } from "./prefilter";
export type { PrefilterInput, PrefilterVerdict } from "./prefilter";
