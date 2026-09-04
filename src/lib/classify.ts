import { groqComplete } from "./groq";
import { CATEGORIES, isCategory, type Category } from "./categories";

// Cheap first pass: most job-pipeline emails use predictable boilerplate phrases.
// Catching them here means zero LLM calls for the majority of emails.
const KEYWORD_RULES: { category: Category; patterns: RegExp[] }[] = [
  // First rule on purpose. An OTP mail from a careers portal often also carries
  // "application" or "account" boilerplate, and misfiling it as Applied would drag
  // a throwaway code into the pipeline counts.
  {
    category: "Verification",
    patterns: [
      /\b(one[- ]?time (password|passcode|code))\b/i,
      /\botp\b/i,
      /verification code/i,
      /security code/i,
      /confirmation code/i,
      /access code/i,
      /verify your (email|account|address|identity)/i,
      /confirm your (email|account|address)/i,
      /email verification/i,
      /two[- ]?factor/i,
      /\b2fa\b/i,
      /magic link/i,
      /(reset|change) your password/i,
      /\bis your .{0,20}code\b/i,
      /\bcode is\b[:\s]*\d{4,8}/i,
    ],
  },
  {
    category: "Rejection",
    patterns: [
      /unfortunately/i,
      /not (be )?moving forward/i,
      /decided to (proceed|move forward) with other/i,
      /regret to inform/i,
      /will not be (moving|proceeding)/i,
      /pursue other candidates/i,
    ],
  },
  {
    category: "Offer",
    patterns: [/pleased to offer/i, /offer letter/i, /job offer/i, /welcome to the team/i, /extend.*an offer/i],
  },
  {
    category: "Interview",
    patterns: [
      /interview invitation/i,
      /schedule (an|your) interview/i,
      /invite you to interview/i,
      /interview confirmation/i,
      /interview.*(scheduled|confirmed)/i,
    ],
  },
  {
    category: "Assessment",
    patterns: [
      /coding challenge/i,
      /online assessment/i,
      /take-?home (test|assignment|challenge)/i,
      /technical assessment/i,
      /complete the assessment/i,
      /hackerrank|codesignal|karat/i,
    ],
  },
  {
    category: "Reminder",
    patterns: [/^reminder:/i, /friendly reminder/i, /don'?t forget/i, /upcoming interview/i, /this is a reminder/i],
  },
  {
    category: "Applied",
    patterns: [
      /application received/i,
      /thank you for applying/i,
      /we('| ha)ve received your application/i,
      /application confirmation/i,
      /successfully submitted/i,
    ],
  },
];

export function keywordClassify(subject: string, snippet: string): Category | null {
  const text = `${subject}\n${snippet}`;
  for (const rule of KEYWORD_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(text))) return rule.category;
  }
  return null;
}

const SYSTEM_PROMPT = `You classify job-application-related emails into exactly one category: ${CATEGORIES.join(
  ", "
)}.

Verification means the email carries a login or signup code rather than pipeline news: one-time passwords, OTPs, verification or security codes, "confirm your email address", password resets, magic links, two-factor prompts. Use it even when the sender is a company he applied to or a job board — if the payload is a code or a confirm-your-account link, it is Verification.

Reply with only the category word and nothing else. If the email is not related to a job application or a job-site account at all, reply with "Skip".`;

// Throws if the Groq call itself fails (bad key, model gone, network) — that's a
// distinct case from "model answered but not with a recognized category word",
// which is a legitimate Skip. Caller (sync/route.ts) decides what a failed call
// means for that message.
export async function llmClassify(subject: string, snippet: string): Promise<Category | "Skip"> {
  const raw = await groqComplete(SYSTEM_PROMPT, `Subject: ${subject}\nSnippet: ${snippet}`, 5);
  if (isCategory(raw)) return raw;
  return "Skip";
}

// Keyword rules first (free, instant), LLM as a fallback for anything ambiguous.
export async function classifyEmail(subject: string, snippet: string): Promise<Category | "Skip"> {
  const byKeyword = keywordClassify(subject, snippet);
  if (byKeyword) return byKeyword;
  return llmClassify(subject, snippet);
}
