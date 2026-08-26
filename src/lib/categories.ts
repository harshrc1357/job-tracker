export const CATEGORIES = [
  "Applied",
  "Assessment",
  "Interview",
  "Offer",
  "Rejection",
  "Reminder",
] as const;

export type Category = (typeof CATEGORIES)[number];

// Maps a category to its badge class in globals.css (mirrors the confirmed mockup).
export const CATEGORY_BADGE_CLASS: Record<Category, string> = {
  Applied: "badge applied",
  Assessment: "badge assessment",
  Interview: "badge interview",
  Offer: "badge offer",
  Rejection: "badge rejection",
  Reminder: "badge reminder",
};

// Categories that push a Telegram message the moment a matching email is found,
// on top of the "due soon" reminder pass in the sync job.
export const NOTIFY_ON_ARRIVAL: Category[] = ["Interview", "Assessment", "Offer", "Reminder"];

// Categories where it's worth asking the LLM to pull a specific date/time out of the
// email, so we can ping again closer to the actual event.
export const EXTRACT_DUE_DATE_FOR: Category[] = ["Interview", "Assessment", "Offer"];

export function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value);
}
