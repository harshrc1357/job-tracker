import { NextRequest, NextResponse } from "next/server";
import type { gmail_v1 } from "googleapis";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { getGmailClient } from "@/lib/gmail";
import { db } from "@/db/client";
import { applications, ignoredMessages } from "@/db/schema";
import { keywordClassify, llmClassify } from "@/lib/classify";
import { extractDueDate } from "@/lib/extractDueDate";
import { escapeMarkdownV2, sendTelegramMessage, trySendTelegramMessage } from "@/lib/telegram";
import {
  EXTRACT_DUE_DATE_FOR,
  NOTIFY_ON_ARRIVAL,
  REMINDER_CATEGORIES,
  type Category,
} from "@/lib/categories";
import {
  LLM_CALLS_PER_RUN,
  MAX_REMINDERS_PER_APPLICATION,
  SYNC_CONCURRENCY,
  SYNC_TIME_BUDGET_MS,
} from "@/lib/constants";
import { decideReminder } from "@/lib/reminderPolicy";
import { isRateLimit } from "@/lib/isRateLimit";
import { sanitizeEmailHtml } from "@/lib/sanitizeEmailHtml";

export const runtime = "nodejs";
export const maxDuration = 60;

// Cast a slightly wide net — the classifier (keyword rules + LLM fallback) is the real
// filter. This query just keeps Gmail from handing back the entire inbox.
//
// Rolling window, not an absolute date range: an `after:/before:` pair goes stale the
// moment the clock passes it, and the sync then silently returns zero new mail forever.
const LOOKBACK_DAYS = 14;
const JOB_QUERY =
  `newer_than:${LOOKBACK_DAYS}d ` +
  '(application OR interview OR assessment OR offer OR "thank you for applying" OR ' +
  'recruiting OR careers OR hiring OR OTP OR "one-time" OR "verification code" OR ' +
  '"security code" OR "verify your email" OR "confirm your email")';

const MAX_LISTED_MESSAGES = 500;

// How many individual errors get quoted in the Telegram alert before it truncates.
const MAX_ALERT_ERRORS = 5;

type SyncResult = {
  listed: number;
  alreadyStored: number;
  processed: number;
  inserted: number;
  ignored: number;
  llmCalls: number;
  remindersSent: number;
  remaining: number;
  ranOutOfTime: boolean;
  hitLlmBudget: boolean;
  wasRateLimited: boolean;
  errors: string[];
};

// What one message turned into. Kept as data rather than as a direct db.insert so the
// fetch/classify work can run concurrently while the writes stay ordered and cheap.
type MessageOutcome =
  // Classified as not job-related. Recorded in ignored_messages so it is never
  // fetched or classified again.
  | { status: "ignore"; messageId: string }
  // Needed an LLM call but the run's budget was spent. Left completely untouched so
  // the next tick picks it up.
  | { status: "defer" }
  // The LLM provider is rate limiting. Distinct from a generic error because there is
  // no point trying the rest of the run — every remaining call fails the same way.
  | { status: "rateLimited"; message: string }
  | { status: "error"; message: string }
  | { status: "store"; values: typeof applications.$inferInsert; notify: boolean };

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const hasTimeLeft = () => Date.now() - startedAt < SYNC_TIME_BUDGET_MS;

  const result: SyncResult = {
    listed: 0,
    alreadyStored: 0,
    processed: 0,
    inserted: 0,
    ignored: 0,
    llmCalls: 0,
    remindersSent: 0,
    remaining: 0,
    ranOutOfTime: false,
    hitLlmBudget: false,
    wasRateLimited: false,
    errors: [],
  };

  // Shared across the whole run. Handed to processMessage so concurrent workers draw
  // from one pool rather than each getting their own allowance.
  const llmBudget = { remaining: LLM_CALLS_PER_RUN, used: 0 };

  try {
    const gmail = await getGmailClient();
    const list = await gmail.users.messages.list({
      userId: "me",
      q: JOB_QUERY,
      maxResults: MAX_LISTED_MESSAGES,
    });
    const messages = list.data.messages ?? [];
    result.listed = messages.length;

    // One query for every id we already hold, instead of a SELECT per message. At a
    // 14-day window that was 100+ sequential database round trips per run before any
    // real work started, and it is most of why every run was hitting the 60s wall.
    const [stored, ignored] = await Promise.all([
      db.select({ gmailMessageId: applications.gmailMessageId }).from(applications),
      db.select({ gmailMessageId: ignoredMessages.gmailMessageId }).from(ignoredMessages),
    ]);
    // Ignored ids count as "seen" exactly like stored ones. That is the whole point:
    // a message judged not-job-related must never cost a second LLM call.
    const seenIds = new Set([
      ...stored.map((row) => row.gmailMessageId),
      ...ignored.map((row) => row.gmailMessageId),
    ]);

    const fresh = messages.flatMap((message) =>
      message.id && !seenIds.has(message.id) ? [message.id] : []
    );
    result.alreadyStored = messages.length - fresh.length;

    // Fetch and classify in small concurrent batches, checking the clock between
    // them. Anything left when the budget runs out simply stays unrecorded, so the
    // next tick picks it up — partial progress that reports itself beats a 504 that
    // reports nothing.
    for (let offset = 0; offset < fresh.length; offset += SYNC_CONCURRENCY) {
      if (!hasTimeLeft()) {
        result.ranOutOfTime = true;
        break;
      }

      const batch = fresh.slice(offset, offset + SYNC_CONCURRENCY);
      const outcomes = await Promise.all(batch.map((id) => processMessage(gmail, id, llmBudget)));
      result.processed += batch.length;
      result.llmCalls = llmBudget.used;

      for (const outcome of outcomes) {
        if (outcome.status === "error") result.errors.push(outcome.message);
        if (outcome.status === "rateLimited" && !result.wasRateLimited) {
          // Report the throttle once, not once per message. The remaining messages
          // are untouched and get picked up whenever the quota comes back.
          result.wasRateLimited = true;
          result.errors.push(outcome.message);
        }
      }

      // Record the skips before anything else. If the run dies after this point the
      // work is still banked, which is what stops the treadmill restarting.
      const toIgnore = outcomes.flatMap((outcome) =>
        outcome.status === "ignore" ? [{ gmailMessageId: outcome.messageId }] : []
      );
      if (toIgnore.length > 0) {
        await db.insert(ignoredMessages).values(toIgnore).onConflictDoNothing();
        result.ignored += toIgnore.length;
      }

      // Budget spent mid-batch: everything after this needs an LLM call we cannot
      // make, so stop cleanly rather than logging one 429 per remaining message.
      if (llmBudget.remaining <= 0 && outcomes.some((o) => o.status === "defer")) {
        result.hitLlmBudget = true;
      }

      const toStore = outcomes.flatMap((outcome) =>
        outcome.status === "store" ? [outcome] : []
      );

      // Store whatever this batch already produced, then stop. Everything past here
      // needs a call the provider is refusing, so continuing only manufactures
      // identical errors.
      if ((result.hitLlmBudget || result.wasRateLimited) && toStore.length === 0) break;
      if (toStore.length === 0) continue;

      // onConflictDoNothing plus `returning` makes this safe against two overlapping
      // runs: whichever loses the race inserts nothing and gets nothing back, so only
      // the winner sends the Telegram notification. No duplicate pings.
      const insertedRows = await db
        .insert(applications)
        .values(toStore.map((outcome) => outcome.values))
        .onConflictDoNothing({ target: applications.gmailMessageId })
        .returning({ gmailMessageId: applications.gmailMessageId });

      const insertedIds = new Set(insertedRows.map((row) => row.gmailMessageId));
      result.inserted += insertedRows.length;

      for (const outcome of toStore) {
        if (!outcome.notify) continue;
        if (!insertedIds.has(outcome.values.gmailMessageId)) continue;
        try {
          await sendTelegramMessage(formatArrivalMessage(outcome.values));
        } catch (err) {
          result.errors.push(`notify ${outcome.values.gmailMessageId}: ${describe(err)}`);
        }
      }
    }

    // Remaining means "not yet banked", not "not yet looked at". A message is only
    // done when it is either stored or recorded as ignored — anything else (errored,
    // deferred, cut off by the clock) comes back on the next run.
    result.remaining = Math.max(fresh.length - result.inserted - result.ignored, 0);

    await runReminderPass(result, hasTimeLeft);
  } catch (err) {
    result.errors.push(describe(err));
    console.error("[sync] failed", err);
    await alertOnProblems(result, describe(err));
    return NextResponse.json({ ok: false, ...result }, { status: 500 });
  }

  await alertOnProblems(result, null);
  return NextResponse.json({ ok: true, ...result });
}

// Fetches one message and works out what, if anything, to store for it. Returns
// rather than throws so one bad message cannot take down the batch around it.
async function processMessage(
  gmail: gmail_v1.Gmail,
  messageId: string,
  llmBudget: { remaining: number; used: number }
): Promise<MessageOutcome> {
  try {
    // format: "full" (not "metadata") because the dashboard shows the whole message
    // when you click into it, not just the list snippet.
    const full = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });

    const headers = full.data.payload?.headers ?? [];
    const subject = headers.find((h) => h.name === "Subject")?.value ?? "(no subject)";
    const from = headers.find((h) => h.name === "From")?.value ?? "";
    const snippet = full.data.snippet ?? "";
    const { text: extractedText, html: bodyHtml } = extractMessageContent(full.data.payload);
    const receivedAt = new Date(Number(full.data.internalDate ?? Date.now()));

    // Keyword rules first: free, instant, and they catch the majority of real
    // pipeline mail. Only genuinely ambiguous messages are worth an LLM call.
    let category = keywordClassify(subject, snippet);

    if (!category) {
      if (llmBudget.remaining <= 0) return { status: "defer" };
      llmBudget.remaining--;
      llmBudget.used++;

      const llmResult = await llmClassify(subject, snippet);
      if (llmResult === "Skip") return { status: "ignore", messageId };
      category = llmResult;
    }

    // Due-date extraction is a second LLM call, so it draws from the same budget.
    // Missing a due date is recoverable (the arrival ping still fires); blowing the
    // daily quota is not.
    let reminderDueAt: Date | null = null;
    if (EXTRACT_DUE_DATE_FOR.includes(category) && llmBudget.remaining > 0) {
      llmBudget.remaining--;
      llmBudget.used++;
      reminderDueAt = await extractDueDate(subject, snippet, receivedAt);
    }

    return {
      status: "store",
      notify: NOTIFY_ON_ARRIVAL.includes(category),
      values: {
        gmailMessageId: messageId,
        company: extractCompany(from, subject),
        category,
        subject,
        snippet,
        body: extractedText || snippet,
        bodyHtml,
        fromEmail: extractEmail(from),
        receivedAt,
        reminderDueAt,
      },
    };
  } catch (err) {
    // Left unrecorded on purpose: the next run re-lists it while it is still inside
    // the lookback window, so a transient Gmail or Groq failure self-heals. A rate
    // limit specifically must never be banked as "not job related" — that would
    // permanently discard real mail because of a temporary quota problem.
    console.error("[sync] failed on message", messageId, err);
    const message = `message ${messageId}: ${describe(err)}`;
    if (isRateLimit(err)) return { status: "rateLimited", message };
    return { status: "error", message };
  }
}

// Repeating "coming up" nudges. Only Interview, Assessment and Offer rows are
// eligible — Applied, Rejection, Reminder and Verification never nudge. Cadence and
// cap live in decideReminder (see reminderPolicy.ts), which is unit tested; this
// function only does the I/O around that decision.
async function runReminderPass(result: SyncResult, hasTimeLeft: () => boolean) {
  const now = new Date();

  const pending = await db
    .select()
    .from(applications)
    .where(
      and(
        isNotNull(applications.reminderDueAt),
        eq(applications.reminderSent, false),
        inArray(applications.category, REMINDER_CATEGORIES)
      )
    );

  for (const app of pending) {
    if (!hasTimeLeft()) {
      result.ranOutOfTime = true;
      return;
    }

    const decision = decideReminder(app, now);
    if (decision.action === "skip") continue;

    if (decision.action === "close") {
      await db.update(applications).set({ reminderSent: true }).where(eq(applications.id, app.id));
      continue;
    }

    // Send first, then record. A failed send must not burn a count, so the row stays
    // eligible and the next tick retries it.
    try {
      await sendTelegramMessage(formatReminderMessage(app, decision.nextCount));
      await db
        .update(applications)
        .set({
          reminderCount: decision.nextCount,
          lastReminderAt: now,
          reminderSent: decision.isFinal,
        })
        .where(eq(applications.id, app.id));
      result.remindersSent++;
    } catch (err) {
      result.errors.push(`reminder ${app.id}: ${describe(err)}`);
      console.error("[sync] reminder failed for application", app.id, err);
    }
  }
}

// A red run in a CI dashboard nobody opens is not a notification. Sync problems have
// to reach the same place the reminders do, or the next outage goes unnoticed for
// days again — which is exactly how this one lasted from Sep 4 to Sep 6.
async function alertOnProblems(result: SyncResult, fatalError: string | null) {
  // A budget stop on its own is normal backlog draining, not a problem worth a ping.
  // It only gets reported when something else already made this alert fire.
  if (!fatalError && result.errors.length === 0 && !result.ranOutOfTime) return;

  // Only the heading is markup. Everything else is escaped body text, because it is
  // all attacker-adjacent: error strings carry subjects, sender names and API
  // responses, any of which can contain a stray asterisk or underscore.
  const lines = ["⚠️ *Job tracker sync problem*"];
  if (fatalError) lines.push(escapeMarkdownV2(`Run failed: ${fatalError}`));
  if (result.ranOutOfTime) {
    lines.push(
      escapeMarkdownV2(
        `Ran out of time with ${result.remaining} message(s) left. They retry next run.`
      )
    );
  }
  if (result.hitLlmBudget) {
    lines.push(
      escapeMarkdownV2(
        `Hit the ${LLM_CALLS_PER_RUN}-call LLM budget with ${result.remaining} message(s) left. They retry next run.`
      )
    );
  }
  if (result.wasRateLimited) {
    lines.push(
      escapeMarkdownV2(
        `Groq is rate limiting. Stopped early with ${result.remaining} message(s) left; they retry once quota returns.`
      )
    );
  }
  if (result.errors.length > 0) {
    lines.push(escapeMarkdownV2(`${result.errors.length} error(s):`));
    // Cap the detail — a broken Groq key produces one error per message and Telegram
    // rejects anything over 4096 characters.
    lines.push(...result.errors.slice(0, MAX_ALERT_ERRORS).map((e) => escapeMarkdownV2(`• ${e}`)));
  }

  await trySendTelegramMessage(lines.join("\n"));
}

function formatArrivalMessage(values: typeof applications.$inferInsert): string {
  const category = escapeMarkdownV2(String(values.category));
  const company = escapeMarkdownV2(values.company);
  const subject = escapeMarkdownV2(values.subject ?? "");
  const snippet = escapeMarkdownV2((values.snippet ?? "").slice(0, 200));
  return `*${category}* — ${company}\n${subject}\n\n_${snippet}_`;
}

function formatReminderMessage(
  app: typeof applications.$inferSelect,
  nextCount: number
): string {
  const category = escapeMarkdownV2(app.category);
  const company = escapeMarkdownV2(app.company);
  const subject = escapeMarkdownV2(app.subject ?? "");
  const due = escapeMarkdownV2(app.reminderDueAt?.toLocaleString() ?? "");
  const counter = escapeMarkdownV2(`Reminder ${nextCount} of ${MAX_REMINDERS_PER_APPLICATION}`);
  return `⏰ *${category} coming up* — ${company}\n${subject}\nDue: ${due}\n_${counter}_`;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
