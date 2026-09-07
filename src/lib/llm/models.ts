// Which models the classifier is allowed to call, in the order it tries them.
//
// Both are OpenRouter endpoints so there is one API key, one base URL and one error
// shape to reason about. Primary is chosen on cost-per-correct-answer rather than
// raw cost: gemini-2.5-flash-lite follows a strict-JSON instruction reliably at
// $0.10/M input, and a classifier that returns unparseable prose is free but useless.
//
// OpenRouter itself imposes no per-request cap on paid model variants (only ":free"
// ones are capped, at 20/min and 50-1000/day depending on lifetime credit). What
// actually throttles us is the upstream provider plus Cloudflare in front of
// OpenRouter, and neither publishes a number. So the limits below are self-imposed
// pacing, deliberately conservative: being paced by us costs milliseconds, being
// paced by them costs a 429, a retry, and real job mail left unclassified for
// another cycle.

export type ModelConfig = {
  // OpenRouter model slug, verified against GET /api/v1/models.
  readonly id: string;
  // Self-imposed pacing. See above — not a published provider number.
  readonly requestsPerMinute: number;
  // Cost ceiling, not a provider limit. One run cannot spend more than this many
  // calls against one model in a calendar day (owner's timezone).
  readonly requestsPerDay: number;
};

// $0.10/M input, $0.40/M output (verified against GET /api/v1/models, 2026-09-07).
// A classification call is ~1.5k input and ~40 output tokens, so ~$0.00017 each and
// the daily ceiling below is worth about 17 cents.
export const PRIMARY_MODEL: ModelConfig = {
  id: "google/gemini-2.5-flash-lite",
  requestsPerMinute: 300,
  requestsPerDay: 1_000,
};

// Only used when the primary is throttling, erroring, or out of daily budget.
// gpt-5-nano is half the input price and a different upstream provider, so a
// Google-side outage does not take the whole classifier down with it.
export const FALLBACK_MODEL: ModelConfig = {
  id: "openai/gpt-5-nano",
  requestsPerMinute: 120,
  requestsPerDay: 300,
};

export const MODEL_CHAIN: readonly ModelConfig[] = [PRIMARY_MODEL, FALLBACK_MODEL];

export function modelById(id: string): ModelConfig | undefined {
  return MODEL_CHAIN.find((model) => model.id === id);
}
