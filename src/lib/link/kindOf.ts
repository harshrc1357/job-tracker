// The one place a stored email becomes a kind for the Linker. The sync-time linker and the
// rebuild after an override both call it, so neither can know a rule the other does not.

import { isCategory, isReminderCategory } from "@/lib/categories";
import { KIND_BY_CATEGORY, type EmailKind } from "./types";

type Row = { category: string; fromEmail: string | null; subject: string | null };

// Mail that lists openings or asks for feedback says nothing about an application of the
// owner. The classifier sometimes calls it Applied or Screening, and the mail then made
// Applications (real rows: Glenmoor, GLX, Kirkwood, Lowell, HYLOX from ZipRecruiter alerts).
// Each rule names the sender it is safe for: "is hiring" in a recruiter's own mail is not an alert.
const ALERT_RULES: { sender: RegExp; subject?: RegExp }[] = [
  { sender: /^alerts@([a-z0-9-]+\.)*ziprecruiter\.com$/ },
  { sender: /@([a-z0-9-]+\.)*ziprecruiter\.com$/, subject: /\b(opening for you|may want to hire you|is hiring now|has an open position)\b/i },
  { sender: /@([a-z0-9-]+\.)*wellfound\.com$/, subject: /^new jobs?:/i },
  { sender: /@([a-z0-9-]+\.)*linkedin\.com$/, subject: /\bis hiring (for|a|an)\b/i },
];

// A request to rate the hiring process, from any sender.
// "Tell us about your experience with Python" is a recruiter's question, so this one needs the hiring process named.
const SURVEY_SUBJECT = [
  /\blove to hear about your .{0,40}experience\b/i,
  /\bhow was your .{0,40}experience\b/i,
  /\brate your .{0,40}experience\b/i,
  /\btell us about your (\w+ ){0,2}(application|interview|hiring|recruiting|candidate) experience\b/i,
];

const addressOf = (from: string | null) => (from?.match(/<([^<>]+)>/)?.[1] ?? from ?? "").trim().toLowerCase();

function isJobAlertOrSurvey({ fromEmail, subject }: Row): boolean {
  const sender = addressOf(fromEmail);
  const text = subject ?? "";
  if (SURVEY_SUBJECT.some((p) => p.test(text))) return true;
  return ALERT_RULES.some((rule) => rule.sender.test(sender) && (!rule.subject || rule.subject.test(text)));
}

export function kindOf(row: Row): EmailKind {
  if (!isCategory(row.category)) return "marketing";
  if (isJobAlertOrSurvey(row)) return "marketing";
  return KIND_BY_CATEGORY[row.category];
}

// Whether this mail may interrupt the owner: a Telegram message on arrival, or a "due soon" reminder.
// A job alert the classifier filed as Screening says nothing about an application of theirs.
export function canPing(row: Row): boolean {
  return isReminderCategory(row.category) && kindOf(row) !== "marketing";
}
