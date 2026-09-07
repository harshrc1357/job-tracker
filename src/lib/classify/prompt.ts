// The classification prompt and the parser for what comes back.
//
// Kept apart from the call machinery so the wording — which is the actual product
// here — can be read and tested on its own, with no network anywhere near it.

import { CATEGORIES, isCategory, type Category } from "@/lib/categories";
import { LlmError } from "@/lib/llm/errors";

export type Verdict =
  | { isJob: true; category: Category; evidence: string }
  | { isJob: false; reason: string };

// Two rules do the heavy lifting and both exist because of a specific failure:
//
// 1. Promotional mail was landing in Interview and Assessment. The fix is not a
//    better keyword list, it is making "is this about an application HE made" a
//    separate question answered BEFORE the category question. A job advert has no
//    category. It is not a weak Applied, it is a non-answer.
//
// 2. "Thank you for your application" emails carry the assessment link and its
//    deadline in the body. Deciding from the subject filed those as Applied and lost
//    the deadline entirely. So the model is told, explicitly, that subjects
//    understate and that the body is the evidence.
export const CLASSIFIER_SYSTEM_PROMPT = `You triage the personal inbox of one job seeker. Answer two questions about the email, in order.

QUESTION 1: is this email about THIS PERSON'S OWN job application, interview process, or job-platform account?

Answer NO for anything broadcast rather than addressed to him personally:
- job adverts, job alerts, digests, "N new jobs", "jobs for you", "recommended for you"
- newsletters, blog posts, webinars, courses, bootcamps, certification and career-coaching marketing
- sponsored or promotional mail from job boards, even when it names a real role
- invitations to apply, "we are hiring", "this role matches your profile", talent-pool blasts, and recruiter prospecting where he has NOT already applied
- platform engagement notifications: profile views, connection requests, "your post got N views", weekly activity summaries
- anything not about him at all

Answer YES only when a specific employer, recruiter, or applicant tracking system is writing about an application he already submitted, a process he is already in, or a login/verification code for an account on a hiring platform.

If the answer is NO, stop. Do not assign a category. A job advert is not a weak "Applied" — it is not part of the pipeline at all.

QUESTION 2: if YES, which stage is it?

Read the ENTIRE body before deciding. Subjects systematically understate: an email titled "Thank you for your application" or "Application received" very often contains an assessment link, an interview scheduling link, or a deadline further down. Missing that is the single most expensive mistake you can make here. Classify by what the body actually announces or asks him to do, not by the subject line.

Categories:
- Verification: the payload is a code or an account link rather than pipeline news — one-time password, OTP, verification/security/confirmation code, "confirm your email address", password reset, magic link, two-factor prompt. Use it even when the sender is a company he applied to.
- Rejection: they are not proceeding with him.
- Offer: they are extending, confirming, or detailing a job offer.
- Interview: an interview is being offered, scheduled, confirmed, rescheduled, or prepared for. Includes scheduling links and availability requests.
- Assessment: he is asked to complete a test, coding challenge, take-home, online assessment, questionnaire, or screening task. Includes deadlines to complete one.
- Reminder: a nudge about something already known — an upcoming interview or an assessment deadline he has already been told about.
- Applied: acknowledgement that an application was received, or a status update with no action and no decision. This is the fallback ONLY when nothing above applies.

When several stages appear in one email, use this priority: Verification > Rejection > Offer > Interview > Assessment > Reminder > Applied. An email that acknowledges an application AND asks for an assessment is Assessment, not Applied.

Reply with ONLY a JSON object, no prose and no code fences:
{"isJob": true, "category": "<one of ${CATEGORIES.join(
  " | "
)}>", "evidence": "<up to 15 words quoted from the email that decided the category>"}
or
{"isJob": false, "reason": "<up to 10 words>"}`;

// Enough for the JSON object with room for a long evidence quote, and short enough
// that a model that decides to write an essay gets cut off rather than billed for it.
export const CLASSIFIER_MAX_TOKENS = 160;

// Defensive on purpose. response_format: json_object makes fenced or prefixed output
// rare, not impossible, and a parse failure here must never be read as "not job
// related" — that silently discards real mail. Unparseable throws.
export function parseVerdict(raw: string, model: string): Verdict {
  const parsed = extractJsonObject(raw);
  if (!parsed) {
    throw new LlmError(`could not parse verdict from: ${raw.slice(0, 200)}`, {
      kind: "unusable",
      model,
    });
  }

  if (parsed.isJob !== true) {
    // Anything that is not an explicit `true` is a skip. A model that answers
    // "false", omits the field, or writes "no" all mean the same thing, and the
    // cost of reading a malformed skip as a skip is one advert not stored.
    return { isJob: false, reason: asShortString(parsed.reason) || "not job related" };
  }

  const category = typeof parsed.category === "string" ? parsed.category.trim() : "";
  if (!isCategory(category)) {
    throw new LlmError(`isJob=true with unknown category ${JSON.stringify(parsed.category)}`, {
      kind: "unusable",
      model,
    });
  }

  return { isJob: true, category, evidence: asShortString(parsed.evidence) };
}

const MAX_EVIDENCE_CHARS = 200;

function asShortString(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, MAX_EVIDENCE_CHARS) : "";
}

// Takes the first {...} block, so a stray "```json" fence or a leading "Here is"
// does not cost a retry.
function extractJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  try {
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
