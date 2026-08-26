import { groqComplete } from "./groq";

// For Interview/Assessment/Offer emails, try to pull out a concrete date/time so the
// sync job can send a second "coming up" reminder closer to the actual event, instead
// of only pinging once when the email first arrives.
export async function extractDueDate(subject: string, snippet: string, referenceDate: Date): Promise<Date | null> {
  const systemPrompt = `Extract the specific date/time of an interview, assessment deadline, or offer deadline mentioned in this email. The email was received on ${referenceDate.toISOString()}, use that to resolve relative dates like "tomorrow" or "next Friday". Reply with only an ISO 8601 datetime (e.g. 2026-08-27T14:00:00) if one is clearly stated, or "None" if no specific date/time is given.`;

  const raw = await groqComplete(systemPrompt, `Subject: ${subject}\nSnippet: ${snippet}`, 20);
  if (!raw || raw.toLowerCase().startsWith("none")) return null;

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
