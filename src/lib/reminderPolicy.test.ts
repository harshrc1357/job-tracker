import { describe, expect, test } from "vitest";
import { decideReminder, type ReminderRow } from "./reminderPolicy";
import {
  MAX_REMINDERS_PER_APPLICATION,
  REMINDER_INTERVAL_HOURS,
  REMINDER_WINDOW_HOURS,
} from "./constants";

const NOW = new Date("2026-09-06T12:00:00Z");
const HOUR = 60 * 60 * 1000;

function row(overrides: Partial<ReminderRow> = {}): ReminderRow {
  return {
    reminderDueAt: new Date(NOW.getTime() + 24 * HOUR),
    reminderCount: 0,
    lastReminderAt: null,
    ...overrides,
  };
}

describe("decideReminder", () => {
  test("sends the first reminder once the event is inside the window", () => {
    // Arrange
    const application = row({ reminderDueAt: new Date(NOW.getTime() + 10 * HOUR) });

    // Act
    const decision = decideReminder(application, NOW);

    // Assert
    expect(decision).toEqual({ action: "send", nextCount: 1, isFinal: false });
  });

  test("stays quiet while the event is further out than the window", () => {
    // Arrange
    const application = row({
      reminderDueAt: new Date(NOW.getTime() + (REMINDER_WINDOW_HOURS + 1) * HOUR),
    });

    // Act
    const decision = decideReminder(application, NOW);

    // Assert
    expect(decision).toEqual({ action: "skip" });
  });

  test("closes the row out once the event is in the past", () => {
    // Arrange: a passed interview should never nudge again, however many are left.
    const application = row({ reminderDueAt: new Date(NOW.getTime() - HOUR), reminderCount: 1 });

    // Act
    const decision = decideReminder(application, NOW);

    // Assert
    expect(decision).toEqual({ action: "close" });
  });

  test("stays quiet until the interval has elapsed since the last nudge", () => {
    // Arrange
    const application = row({
      reminderCount: 1,
      lastReminderAt: new Date(NOW.getTime() - (REMINDER_INTERVAL_HOURS - 1) * HOUR),
    });

    // Act
    const decision = decideReminder(application, NOW);

    // Assert
    expect(decision).toEqual({ action: "skip" });
  });

  test("sends again once the interval has elapsed", () => {
    // Arrange
    const application = row({
      reminderCount: 1,
      lastReminderAt: new Date(NOW.getTime() - REMINDER_INTERVAL_HOURS * HOUR),
    });

    // Act
    const decision = decideReminder(application, NOW);

    // Assert
    expect(decision).toEqual({ action: "send", nextCount: 2, isFinal: false });
  });

  test("marks the last allowed reminder as final so the row closes with it", () => {
    // Arrange
    const application = row({
      reminderCount: MAX_REMINDERS_PER_APPLICATION - 1,
      lastReminderAt: new Date(NOW.getTime() - REMINDER_INTERVAL_HOURS * HOUR),
    });

    // Act
    const decision = decideReminder(application, NOW);

    // Assert
    expect(decision).toEqual({
      action: "send",
      nextCount: MAX_REMINDERS_PER_APPLICATION,
      isFinal: true,
    });
  });

  test("closes rather than sending once the hard cap is reached", () => {
    // Arrange
    const application = row({
      reminderCount: MAX_REMINDERS_PER_APPLICATION,
      lastReminderAt: new Date(NOW.getTime() - 50 * HOUR),
    });

    // Act
    const decision = decideReminder(application, NOW);

    // Assert
    expect(decision).toEqual({ action: "close" });
  });

  test("never sends more than the cap across a long run of ticks", () => {
    // Arrange: walk an hour at a time from 48h out down to the event itself,
    // feeding each decision back in the way the cron would.
    let application = row({ reminderDueAt: new Date(NOW.getTime() + 48 * HOUR) });
    let sent = 0;

    // Act
    for (let hour = 0; hour <= 48; hour++) {
      const tick = new Date(NOW.getTime() + hour * HOUR);
      const decision = decideReminder(application, tick);
      if (decision.action === "send") {
        sent++;
        application = { ...application, reminderCount: decision.nextCount, lastReminderAt: tick };
      }
    }

    // Assert
    expect(sent).toBe(MAX_REMINDERS_PER_APPLICATION);
  });

  test("ignores a row with no due date at all", () => {
    // Arrange
    const application = row({ reminderDueAt: null });

    // Act
    const decision = decideReminder(application, NOW);

    // Assert
    expect(decision).toEqual({ action: "skip" });
  });
});
