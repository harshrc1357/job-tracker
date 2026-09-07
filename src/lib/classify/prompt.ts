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
- platform engagement notifications that are not about an application: profile views, connection requests, "your post got N views", weekly activity summaries. An email about one of HIS applications is never this, no matter how much notification boilerplate ("this email was intended for...", "you are receiving LinkedIn notification emails", an unsubscribe footer) it is wrapped in.
- anything not about him at all

Answer YES when a specific employer, recruiter, or applicant tracking system is writing about an application he already submitted, a process he is already in, or a login/verification code for an account on a hiring platform.

The sender does NOT decide this. Most application mail is relayed by a job board or an ATS — LinkedIn, Indeed, Ashby, Greenhouse, Lever, Workday, iCIMS, SmartRecruiters — and arrives from a noreply address on their domain rather than from the company. That is still YES. What decides it is whether the email is about ONE named role he already applied to.

The distinction is the direction of the action, so compare these carefully:
- "Your application to AI Engineer at TechClub was sent" / "Your application has been submitted" / "Thank you for submitting your application to the Applied AI position at Juniper Square" — YES. A specific application of his already exists. Category Applied.
- "This role could be a match, submit a quick application" / "Macmillan Learning may want to hire you" / "6 new jobs are waiting" — NO. It is asking him to start something.

An email is not disqualified for being automated, templated, or carrying an unsubscribe link. Nearly all real ATS mail is all three.

If the input carries the line "Signal: the subject states this is HIS OWN application to a named role", QUESTION 1 is already answered YES and you must not overrule it. That signal is computed from the subject, not guessed. Go straight to QUESTION 2, and answer Applied unless the body clearly shows a later stage.

A thin body is not disqualifying either. Job boards send status updates whose body is almost entirely platform chrome — "Your update from Future Secure AI", a logo, a footer — while the subject carries the whole message: "Your application to AI Engineer, Software at Future Secure AI". If the email names ONE specific role at ONE named company AND refers to it as HIS application ("your application to...", "your application was sent to..."), that is YES and the category is Applied, however little text the body contains. The possessive is what separates it from "Macmillan Learning may want to hire you", which names a company but describes a job he has not applied to.

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
// Raised from 160 after a real row hit the cap mid-evidence and came back as
// unterminated JSON; salvageVerdict below covers the residual case.
export const CLASSIFIER_MAX_TOKENS = 220;

// Defensive on purpose. response_format: json_object makes fenced or prefixed output
// rare, not impossible, and a parse failure here must never be read as "not job
// related" — that silently discards real mail. Unparseable throws.
export function parseVerdict(raw: string, model: string): Verdict {
  const parsed = extractJsonObject(raw) ?? salvageTruncated(raw);
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

// Rescues the one failure mode that is fully understood: the model ran into
// max_tokens partway through the evidence quote, so the JSON is unterminated. A real
// row did exactly this — {"isJob": true, "category": "Applied", "evidence": "Thank
// you for appl — and threw away a correct answer over a missing brace.
//
// Safe because the prompt fixes the field order, so a cut in `evidence` always leaves
// isJob and category complete. Deliberately strict: BOTH fields must be present and
// explicit, and the category must be one of ours. It cannot invent a verdict out of
// prose, only recover one that is already unambiguously stated. The evidence is lost,
// which costs a little diagnosability and nothing else.
function salvageTruncated(raw: string): Record<string, unknown> | null {
  if (!/"isJob"\s*:\s*true/.test(raw)) return null;
  const category = raw.match(/"category"\s*:\s*"([A-Za-z]+)"/);
  if (!category || !isCategory(category[1])) return null;
  return { isJob: true, category: category[1], evidence: "" };
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
