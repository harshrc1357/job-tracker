import { describe, expect, test } from "vitest";
import { EXTRACT_DUE_DATE_FOR, NOTIFY_ON_ARRIVAL, REMINDER_CATEGORIES, isReminderCategory } from "./categories";

// Which mail is worth interrupting the owner about. One list drives all three behaviours on
// purpose, so a category cannot ping on arrival but never repeat, or the other way round.
describe("what the owner gets a Telegram message about", () => {
  test.each(["Screening", "Assessment", "Interview", "Offer"])(
    "%s: arrival ping, repeating reminders and due-date extraction",
    (category) => {
      expect(NOTIFY_ON_ARRIVAL).toContain(category);
      expect(REMINDER_CATEGORIES).toContain(category);
      expect(EXTRACT_DUE_DATE_FOR).toContain(category);
      expect(isReminderCategory(category)).toBe(true);
    },
  );

  // A staffing agency's job description is shown in the Inbox and nothing more, until the
  // same thread turns into a Screening, Assessment or Interview.
  test.each(["Applied", "Rejection", "Reminder", "Staffing/recruiter", "Verification"])("%s is dashboard-only", (category) => {
    expect(NOTIFY_ON_ARRIVAL).not.toContain(category);
    expect(REMINDER_CATEGORIES).not.toContain(category);
    expect(EXTRACT_DUE_DATE_FOR).not.toContain(category);
    expect(isReminderCategory(category)).toBe(false);
  });
});
