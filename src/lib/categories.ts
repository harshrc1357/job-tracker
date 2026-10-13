export const CATEGORIES = [
  "Applied",
  "Screening",
  "Assessment",
  "Interview",
  "Offer",
  "Rejection",
  "Reminder",
  "Staffing/recruiter",
  "Verification",
] as const;

export type Category = (typeof CATEGORIES)[number];

// The one category the Linker never turns into an Application by itself.
export const STAFFING_CATEGORY: Category = "Staffing/recruiter";

// Maps a category to its badge class in globals.css (mirrors the confirmed mockup).
export const CATEGORY_BADGE_CLASS: Record<Category, string> = {
  Applied: "badge applied",
  Screening: "badge screening",
  Assessment: "badge assessment",
  Interview: "badge interview",
  Offer: "badge offer",
  Rejection: "badge rejection",
  Reminder: "badge reminder",
  // The label has a slash, so the class is not derived from it.
  "Staffing/recruiter": "badge staffing",
  Verification: "badge verification",
};

// The only categories that generate Telegram reminders. Everything else — Applied,
// Rejection, Reminder, Verification — is dashboard-only. Verification in particular
// (OTPs, email-confirmation codes) must never ping: the code is stale by the time a
// reminder would fire, and it would be pure noise.
export const REMINDER_CATEGORIES: Category[] = ["Screening", "Interview", "Assessment", "Offer"];

// Categories that push a Telegram message the moment a matching email is found,
// on top of the repeating "due soon" reminder pass in the sync job. Same list,
// deliberately: one source of truth for what is worth interrupting him about.
export const NOTIFY_ON_ARRIVAL: Category[] = REMINDER_CATEGORIES;

// Categories where it's worth asking the LLM to pull a specific date/time out of the
// email, so we can ping again closer to the actual event.
export const EXTRACT_DUE_DATE_FOR: Category[] = REMINDER_CATEGORIES;

export function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value);
}

export function isReminderCategory(value: string): boolean {
  return REMINDER_CATEGORIES.includes(value as Category);
}
