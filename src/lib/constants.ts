// Shared tuning knobs used by both the sync cron and the dashboard, so the two
// never drift out of sync with each other.

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
