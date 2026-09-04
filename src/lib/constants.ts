// Shared tuning knobs used by both the sync cron and the dashboard, so the two
// never drift out of sync with each other.

// How far ahead a reminder counts as "coming up" — both for the one-time
// Telegram nudge the sync job sends, and for what the dashboard's Upcoming
// reminders panel considers worth showing.
export const REMINDER_WINDOW_HOURS = 48;
