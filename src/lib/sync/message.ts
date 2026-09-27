// Turning one Gmail message id into "store this row", "ignore it", or "try again
// later". Extracted from the /api/sync route so two callers with very different
// constraints can share exactly one copy of it:
//
//   /api/sync          - incremental, runs on Vercel, hard 60s ceiling, must give up
//                        politely and let the next tick continue.
//   scripts/backfill   - one-off bulk import, runs on a real machine, no ceiling,
//                        works through a 45-day window until it is finished.
//
// The duplication this avoids is not cosmetic. Company extraction, HTML sanitizing,
// base64url decoding and the "a rate limit is never a skip" rule are all decisions
// that must not drift between a backfill and a live sync, because a row written by
// one has to be indistinguishable from a row written by the other.

import type { gmail_v1 } from "googleapis";
import { applications } from "@/db/schema";
import { classifyEmail } from "@/lib/classify";
import { extractDueDate } from "@/lib/extractDueDate";
import { LlmUnavailableError } from "@/lib/llm/errors";
import { isRateLimit } from "@/lib/isRateLimit";
import { sanitizeEmailHtml } from "@/lib/sanitizeEmailHtml";
import { EXTRACT_DUE_DATE_FOR, NOTIFY_ON_ARRIVAL } from "@/lib/categories";

// The Gmail search both callers run. Rolling window, not an absolute date range: an
// `after:/before:` pair goes stale the moment the clock passes it, and the sync then
// silently returns zero new mail forever.
export function buildJobQuery(days: number): string {
  return (
    `newer_than:${days}d ` +
    '(application OR interview OR assessment OR offer OR "thank you for applying" OR ' +
    'recruiting OR careers OR hiring OR OTP OR "one-time" OR "verification code" OR ' +
    '"security code" OR "verify your email" OR "confirm your email")'
  );
}

// How many LLM calls this message is allowed to draw. Passed in rather than owned
// here so concurrent workers share one pool instead of each getting an allowance.
export type LlmBudget = { remaining: number; used: number };

// What one message turned into. Kept as data rather than a direct db.insert so the
// fetch/classify work can run concurrently while the writes stay ordered and cheap.
export type MessageOutcome =
  // Classified as not job-related. Recorded in ignored_messages so it is never
  // fetched or classified again.
  | { status: "ignore"; messageId: string }
  // Needed an LLM call but the caller's budget is spent. Left completely untouched so
  // the next run picks it up.
  | { status: "defer" }
  // The LLM provider is rate limiting. Distinct from a generic error because there is
  // no point trying the rest of the run - every remaining call fails the same way.
  | { status: "rateLimited"; message: string }
  | { status: "error"; message: string }
  | {
      status: "store";
      values: typeof applications.$inferInsert;
      notify: boolean;
      usedFallback: boolean;
    };

export async function processMessage(
  gmail: gmail_v1.Gmail,
  messageId: string,
  llmBudget: { remaining: number; used: number }
): Promise<MessageOutcome> {
  try {
    // format: "full" (not "metadata") because the dashboard shows the whole message
    // when you click into it, not just the list snippet.
    const full = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });

    const headerList = full.data.payload?.headers ?? [];
    const headers = toHeaderMap(headerList);
    const subject = headers["subject"] || "(no subject)";
    const from = headers["from"] ?? "";
    const snippet = full.data.snippet ?? "";
    const { text: extractedText, html: bodyHtml } = extractMessageContent(full.data.payload);
    const receivedAt = new Date(Number(full.data.internalDate ?? Date.now()));
    const body = extractedText || snippet;

    // Every message that survives the free prefilter costs one LLM call, with no
    // keyword shortcut in front of it. That shortcut used to decide from the subject
    // line alone, which filed "Thank you for your application" emails as Applied
    // without ever reading the assessment link and deadline in the body. See
    // src/lib/classify/index.ts.
    //
    // The budget is handed in rather than spent here, so it is charged only once the
    // prefilter has declined to reject the message for free.
    const classification = await classifyEmail(
      {
        subject,
        from,
        to: headers["to"] ?? "",
        cc: headers["cc"] ?? "",
        body,
        snippet,
        headers,
      },
      {
        tryReserve: () => {
          if (llmBudget.remaining <= 0) return false;
          llmBudget.remaining--;
          llmBudget.used++;
          return true;
        },
      }
    );

    if (classification.decision === "deferred") return { status: "defer" };
    if (classification.decision === "skip") return { status: "ignore", messageId };
    const { category } = classification;

    // Due-date extraction is a second LLM call, so it draws from the same budget.
    // Missing a due date is recoverable (the arrival ping still fires); blowing the
    // daily quota is not. Reads the body for the same reason the classifier does —
    // "complete by Friday 5pm" is rarely inside the first 200 characters.
    let reminderDueAt: Date | null = null;
    if (EXTRACT_DUE_DATE_FOR.includes(category) && llmBudget.remaining > 0) {
      llmBudget.remaining--;
      llmBudget.used++;
      reminderDueAt = await extractDueDate(subject, body, receivedAt);
    }

    return {
      status: "store",
      notify: NOTIFY_ON_ARRIVAL.includes(category),
      usedFallback: classification.usedFallback,
      values: {
        classifiedBy: classification.model,
        classifierEvidence: classification.evidence,
        gmailMessageId: messageId,
        company: extractCompany(from, subject),
        category,
        subject,
        snippet,
        body,
        bodyHtml,
        fromEmail: extractEmail(from),
        receivedAt,
        reminderDueAt,
      },
    };
  } catch (err) {
    // Left unrecorded on purpose: the next run re-lists it while it is still inside
    // the lookback window, so a transient Gmail or provider failure self-heals. A
    // rate limit specifically must never be banked as "not job related" — that would
    // permanently discard real mail because of a temporary quota problem. The same
    // goes for LlmUnavailableError: every model failing is a reason to try again
    // later, never a reason to conclude the email was not about a job.
    console.error("[sync] failed on message", messageId, err);
    const message = `message ${messageId}: ${describe(err)}`;
    if (err instanceof LlmUnavailableError) {
      return err.isThrottled ? { status: "rateLimited", message } : { status: "error", message };
    }
    if (isRateLimit(err)) return { status: "rateLimited", message };
    return { status: "error", message };
  }
}

// Repeating "coming up" nudges. Only Interview, Assessment and Offer rows are
// eligible — Applied, Rejection, Reminder and Verification never nudge. Cadence and
// cap live in decideReminder (see reminderPolicy.ts), which is unit tested; this

export function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Gmail returns headers as a list and does not normalise the case of the names, so
// "Message-ID" and "Message-Id" both occur in the wild. Lowercasing once here means
// every reader downstream (prefilter's bulk-header checks, the To/Cc lookup) can use
// a plain lowercase key.
export function toHeaderMap(headers: gmail_v1.Schema$MessagePartHeader[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const header of headers) {
    if (!header.name) continue;
    const key = header.name.toLowerCase();
    // First wins. A duplicated Subject or From is a spoofing trick, and the first
    // occurrence is the one Gmail itself displays.
    if (map[key] === undefined) map[key] = header.value ?? "";
  }
  return map;
}

// Pulls both a plain-text and an HTML rendering out of a Gmail message payload.
// `html` is the sanitized text/html part, if the sender sent one — the dashboard
// renders this in a sandboxed iframe so an email looks the way Gmail shows it,
// not flattened to plain text. `text` is the text/plain part when present, or
// (only when there's no text/plain at all — some ATS senders, e.g. Workday,
// Greenhouse, only send HTML) the HTML part with tags stripped, as a fallback
// for search/notifications/older clients. Walks payload.parts recursively
// because multipart messages nest a "multipart/alternative" wrapper around the
// actual text parts.
function extractMessageContent(payload: gmail_v1.Schema$MessagePart | undefined): {
  text: string;
  html: string | null;
} {
  if (!payload) return { text: "", html: null };

  const plainData = findPart(payload, "text/plain");
  const htmlData = findPart(payload, "text/html");
  const rawHtml = htmlData ? decodeBase64Url(htmlData) : null;

  const text = plainData ? decodeBase64Url(plainData).trim() : rawHtml ? stripHtml(rawHtml) : "";
  const html = rawHtml ? sanitizeEmailHtml(rawHtml) : null;

  return { text, html };
}

function findPart(part: gmail_v1.Schema$MessagePart, mimeType: string): string | null {
  if (part.mimeType === mimeType && part.body?.data) return part.body.data;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return null;
}

function decodeBase64Url(data: string): string {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf-8");
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// "Recruiting Team <hr@bjak.my>" -> "hr@bjak.my". Falls back to the raw header
// value on the rare From line that isn't in name+angle-bracket form.
function extractEmail(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return match ? match[1] : from.trim();
}

function extractCompany(from: string, subject: string): string {
  const nameMatch = from.match(/^"?([^"<]+)"?\s*</);
  if (nameMatch) {
    return nameMatch[1].trim().replace(/\s+(careers|recruiting|talent|hr|hiring)$/i, "");
  }
  const domainMatch = from.match(/@([^.\s>]+)\./);
  if (domainMatch) {
    const domain = domainMatch[1];
    return domain.charAt(0).toUpperCase() + domain.slice(1);
  }
  return subject.slice(0, 30);
}
