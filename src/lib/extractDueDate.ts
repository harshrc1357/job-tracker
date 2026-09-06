import { groqComplete } from "./groq";
import { parseDueDate } from "./parseDueDate";
import { OWNER_TIME_ZONE } from "./constants";

// For Interview/Assessment/Offer emails, try to pull out a concrete date/time so the
// sync job can send "coming up" reminders closer to the actual event, instead of only
// pinging once when the email first arrives.
//
// The model is asked for the owner's local wall-clock time and told not to invent an
// offset, because it has no reliable way to know the sender's zone. parseDueDate then
// resolves that reading against OWNER_TIME_ZONE explicitly. See parseDueDate.ts for
// why leaving that to `new Date()` was wrong.
export async function extractDueDate(
  subject: string,
  snippet: string,
  referenceDate: Date
): Promise<Date | null> {
  const systemPrompt = [
    "Extract the specific date and time of an interview, assessment deadline, or offer deadline mentioned in this email.",
    `The email was received on ${referenceDate.toISOString()} — use that to resolve relative dates like "tomorrow" or "next Friday".`,
    `Give the time as local wall-clock time in ${OWNER_TIME_ZONE}. Do not append a timezone offset or a Z.`,
    'Reply with only an ISO 8601 datetime such as 2026-08-27T14:00:00, or "None" if no specific date or time is stated.',
  ].join(" ");

  const raw = await groqComplete(systemPrompt, `Subject: ${subject}\nSnippet: ${snippet}`, 20);
  return parseDueDate(raw, OWNER_TIME_ZONE);
}
