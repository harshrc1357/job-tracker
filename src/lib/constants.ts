// Shared tuning knobs used by both the sync cron and the dashboard, so the two
// never drift out of sync with each other.

// Single-user tool, so "local time" has exactly one meaning. Every wall-clock
// reading the LLM pulls out of an email is resolved against this, rather than
// against wherever the code happens to be running (UTC, on Vercel).
export const OWNER_TIME_ZONE = process.env.OWNER_TIME_ZONE || "America/Chicago";

// Wall-clock budget for one sync run. A slow run returns partial progress and says
// how much is left, and the next tick picks up where it stopped, rather than being
// killed mid-flight and reporting nothing.
//
// Two ceilings to stay under, and the tighter one wins:
//   Vercel Hobby   kills the function at 60s with a 504.
//   cron-job.org   closes the connection at 30s on the free plan (5 min for paying
//                  members) and records the run as FAILED.
//
// That second one is the binding constraint now that an external pinger drives this.
// The work would still finish server-side after a cut-off, but the pinger would log
// a failure for a run that actually succeeded, and with "disable after too many
// failures" enabled that eventually switches the job off. Silent death by false
// alarm is exactly the failure mode this whole trigger rework exists to remove.
//
// 20s leaves ~10s of headroom for cold starts and the response itself. It costs
// nothing in practice: a steady-state run has almost nothing to do, and a backlog
// simply drains over a few more ticks, which is the intended behaviour anyway.
export const SYNC_TIME_BUDGET_MS = 20_000;

// How many messages are fetched and classified at once. Each one is a Gmail round
// trip plus one or two OpenRouter calls, so this is latency-bound, not CPU-bound.
// Too high and Gmail starts returning 429s. The LLM side is paced separately by the
// per-model token bucket in llm/rateLimiter.ts, which is what keeps a burst of
// concurrent workers under the provider's per-minute tolerance.
export const SYNC_CONCURRENCY = 6;

// Hard ceiling on LLM calls in a single run — classification plus due-date
// extraction, drawn from one pool. Its job is bounding the blast radius of one bad
// run (a prompt regression, a backlog spike), not managing spend: the durable
// per-day cap in llm/models.ts does that. Anything past the budget is simply left
// for the next tick, which drains a backlog gradually instead of falling off a cliff.
export const LLM_CALLS_PER_RUN = 80;

// Floor on how often a sync may actually run, whoever asks for it.
//
// This is what makes /api/sync safe to expose without a secret: the cost of being
// called is bounded by the clock rather than by who is calling. Set just under the
// 5-minute cron so ordinary jitter in the trigger never gets a legitimate tick
// rejected, and far enough above a run's ~30s duration that the claim doubles as a
// mutual-exclusion lock (see lib/syncClaim.ts).
export const MIN_SYNC_INTERVAL_MS = 4 * 60 * 1000;

// How far ahead a reminder counts as "coming up" — both for the repeating
// Telegram nudge the sync job sends, and for what the dashboard's Upcoming
// reminders panel considers worth showing.
export const REMINDER_WINDOW_HOURS = 48;

// Minimum gap between two Telegram nudges for the same application. The cron runs
// far more often than this, so every pass re-checks the gap instead of assuming a
// fixed schedule.
export const REMINDER_INTERVAL_HOURS = 8;

// Hard cap on nudges per application. Once this many have gone out, the row is
// marked done and never pings again, however long the event is still away.
export const MAX_REMINDERS_PER_APPLICATION = 4;
