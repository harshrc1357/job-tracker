import { complete } from "./llm/complete";
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
//
// Reads the body, not just the snippet, for the same reason the classifier does: the
// date lives in the middle of the email ("your assessment must be completed by
// Friday 5pm"), and the snippet is the first ~200 characters of greeting.

const MAX_DUE_DATE_TOKENS = 32;

// The date is almost always in the first screenful or the sign-off. Deliberately
// tighter than the classifier's window — this call only runs on emails already known
// to be pipeline mail, and it is the second call for that message.
const MAX_BODY_CHARS = 3_000;

export async function extractDueDate(
  subject: string,
  body: string,
  referenceDate: Date
): Promise<Date | null> {
  const system = [
    "Extract the specific date and time of an interview, assessment deadline, or offer deadline mentioned in this email.",
    `The email was received on ${referenceDate.toISOString()} — use that to resolve relative dates like "tomorrow" or "next Friday".`,
    `Give the time as local wall-clock time in ${OWNER_TIME_ZONE}. Do not append a timezone offset or a Z.`,
    'Reply with only an ISO 8601 datetime such as 2026-08-27T14:00:00, or "None" if no specific date or time is stated.',
  ].join(" ");

  const response = await complete({
    system,
    user: `Subject: ${subject}\n\n${body.slice(0, MAX_BODY_CHARS)}`,
    maxTokens: MAX_DUE_DATE_TOKENS,
  });

  return parseDueDate(response.content, OWNER_TIME_ZONE);
}
