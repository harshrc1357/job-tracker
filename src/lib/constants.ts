// Shared tuning knobs used by both the sync cron and the dashboard, so the two
// never drift out of sync with each other.

// Single-user tool, so "local time" has exactly one meaning. Every wall-clock
// reading the LLM pulls out of an email is resolved against this, rather than
// against wherever the code happens to be running (UTC, on Vercel).
export const OWNER_TIME_ZONE = process.env.OWNER_TIME_ZONE || "America/Chicago";

// Wall-clock budget for one sync run. Vercel's Hobby plan kills the function at 60s
// with a 504, and a killed run reports nothing at all — no counts, no errors. Coming
// in under the axe deliberately means a slow run returns partial progress and says
// how much is left, and the next tick picks up where it stopped.
export const SYNC_TIME_BUDGET_MS = 45_000;

// How many messages are fetched and classified at once. Each one is a Gmail round
// trip plus up to one Groq call, so this is latency-bound, not CPU-bound. Too high
// and Gmail starts returning 429s.
export const SYNC_CONCURRENCY = 6;

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
