// Recognises "the provider is throttling us" as distinct from "this one message
// failed". The difference matters: an ordinary error affects one email and the run
// should carry on, while a rate limit means every remaining call in the run will
// fail the same way. Carrying on there produces one useless error per message and
// spends the LLM budget on requests that cannot succeed.
//
// Deliberately never treated as "not job related" by the caller — banking a rate
// limit as a skip would permanently discard real mail over a temporary quota problem.

// Bounded by non-digits so a message id like "1a0764291bcc" cannot match.
const STATUS_429 = /(^|\D)429(\D|$)/;

const RATE_LIMIT_PHRASES = ["rate_limit_exceeded", "rate limit", "too many requests", "quota exceeded"];

export function isRateLimit(err: unknown): boolean {
  const text = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (!text) return false;

  const lower = text.toLowerCase();
  if (RATE_LIMIT_PHRASES.some((phrase) => lower.includes(phrase))) return true;
  return STATUS_429.test(text);
}
