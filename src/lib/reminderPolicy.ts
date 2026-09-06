import {
  MAX_REMINDERS_PER_APPLICATION,
  REMINDER_INTERVAL_HOURS,
  REMINDER_WINDOW_HOURS,
} from "./constants";

// The subset of an application row the reminder decision actually depends on.
// Narrow on purpose: it keeps this testable without a database and makes it
// obvious that nothing else about the email can change the outcome.
export type ReminderRow = {
  reminderDueAt: Date | null;
  reminderCount: number;
  lastReminderAt: Date | null;
};

export type ReminderDecision =
  // Nothing to do this tick.
  | { action: "skip" }
  // Stop asking about this row for good, without sending anything.
  | { action: "close" }
  // Send a nudge. `isFinal` means this one hits the cap, so the row closes with it.
  | { action: "send"; nextCount: number; isFinal: boolean };

const HOUR_MS = 60 * 60 * 1000;

// Pure so the cadence can be tested directly, including the property that matters
// most: across any sequence of ticks, a row can never exceed the hard cap.
export function decideReminder(row: ReminderRow, now: Date): ReminderDecision {
  const { reminderDueAt, reminderCount, lastReminderAt } = row;

  if (!reminderDueAt) return { action: "skip" };

  // The event has been and gone. Nothing left to remind about.
  if (reminderDueAt.getTime() <= now.getTime()) return { action: "close" };

  // Already had its allotted nudges.
  if (reminderCount >= MAX_REMINDERS_PER_APPLICATION) return { action: "close" };

  // Too far out to be worth interrupting for. Checked after the cap so a row that is
  // both far out and finished still gets closed instead of lingering in the query.
  const windowEnd = now.getTime() + REMINDER_WINDOW_HOURS * HOUR_MS;
  if (reminderDueAt.getTime() > windowEnd) return { action: "skip" };

  // Space the nudges out. The cron ticks far more often than the interval, so this
  // gap check (not the schedule) is what actually enforces the cadence.
  if (lastReminderAt && now.getTime() - lastReminderAt.getTime() < REMINDER_INTERVAL_HOURS * HOUR_MS) {
    return { action: "skip" };
  }

  const nextCount = reminderCount + 1;
  return { action: "send", nextCount, isFinal: nextCount >= MAX_REMINDERS_PER_APPLICATION };
}
