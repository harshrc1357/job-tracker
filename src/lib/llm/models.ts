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
// OpenRouter, and neither publishes a number. So the per-minute figures below are
// self-imposed pacing: being paced by us costs milliseconds, being paced by them
// costs a 429, a retry, and real job mail left unclassified for another cycle.
//
// The per-minute number is derived rather than picked. Only SYNC_CONCURRENCY workers
// ever run at once and each is one in-flight HTTP request, so the fastest this code
// can physically issue calls is SYNC_CONCURRENCY per second — 360/min at a
// concurrency of 6. That is the whole useful range:
//
//   set it above 360  -> the bucket never empties and the limiter does nothing
//   set it below 360  -> we throttle our own concurrency for no external reason
//
// So it sits exactly at the ceiling. The limiter then acts purely as a backstop
// against SYNC_CONCURRENCY being raised later without anyone rechecking this file,
// and the default burst (requestsPerMinute / 60) lands on 6, which is one batch.
//
// The per-DAY figures are a cost ceiling, not a provider limit, and they are sized
// against measured volume: this inbox produces ~21 stored job emails a day (14-day
// average) against a worst observed day of 56, and the free prefilter kills roughly
// half of everything before it reaches a model. That puts steady state near 85 calls
// a day and a bad day near 450. 1000 per model is ~2x the worst day observed.
const MAX_REQUESTS_PER_MINUTE = 360;

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
  requestsPerMinute: MAX_REQUESTS_PER_MINUTE,
  requestsPerDay: 1_000,
};

// Only used when the primary is throttling, erroring, or out of daily budget.
// gpt-5-nano is half the input price ($0.05/M in, $0.40/M out) and a different
// upstream provider, so a Google-side outage does not take the whole classifier down
// with it.
//
// Given the same 1000/day as the primary on purpose. A fallback sized smaller than
// the thing it backs up is not a fallback: the failure it exists for is the primary
// being unavailable for a whole day, and a 300-call ceiling would have covered a
// third of that day and then gone dark. It is also the cheaper model, so matching the
// ceiling costs less than the primary's does.
export const FALLBACK_MODEL: ModelConfig = {
  id: "openai/gpt-5-nano",
  requestsPerMinute: MAX_REQUESTS_PER_MINUTE,
  requestsPerDay: 1_000,
};

export const MODEL_CHAIN: readonly ModelConfig[] = [PRIMARY_MODEL, FALLBACK_MODEL];

export function modelById(id: string): ModelConfig | undefined {
  return MODEL_CHAIN.find((model) => model.id === id);
}
