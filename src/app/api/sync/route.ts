import { NextRequest, NextResponse } from "next/server";
import type { gmail_v1 } from "googleapis";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { getGmailClient } from "@/lib/gmail";
import { db } from "@/db/client";
import { applications } from "@/db/schema";
import { classifyEmail } from "@/lib/classify";
import { extractDueDate } from "@/lib/extractDueDate";
import { sendTelegramMessage } from "@/lib/telegram";
import {
  EXTRACT_DUE_DATE_FOR,
  NOTIFY_ON_ARRIVAL,
  REMINDER_CATEGORIES,
  type Category,
} from "@/lib/categories";
import {
  MAX_REMINDERS_PER_APPLICATION,
  REMINDER_INTERVAL_HOURS,
  REMINDER_WINDOW_HOURS,
} from "@/lib/constants";
import { sanitizeEmailHtml } from "@/lib/sanitizeEmailHtml";

export const runtime = "nodejs";
export const maxDuration = 60;

// Cast a slightly wide net — the classifier (keyword rules + LLM fallback) is the real
// filter. This query just keeps Gmail from handing back the entire inbox.
//
// Rolling window, not an absolute date range: an `after:/before:` pair goes stale the
// moment the clock passes it, and the sync then silently returns zero new mail forever.
// Deduping happens against gmail_message_id, so re-scanning the same fortnight every
// run is cheap and means a message that failed mid-batch gets picked back up.
const LOOKBACK_DAYS = 14;
const JOB_QUERY =
  `newer_than:${LOOKBACK_DAYS}d ` +
  '(application OR interview OR assessment OR offer OR "thank you for applying" OR ' +
  'recruiting OR careers OR hiring OR OTP OR "one-time" OR "verification code" OR ' +
  '"security code" OR "verify your email" OR "confirm your email")';

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const result = { checked: 0, inserted: 0, remindersSent: 0, errors: [] as string[] };

  try {
    const gmail = await getGmailClient();
    const list = await gmail.users.messages.list({ userId: "me", q: JOB_QUERY, maxResults: 500 });
    const messages = list.data.messages ?? [];
    result.checked = messages.length;

    for (const message of messages) {
      if (!message.id) continue;

      const already = await db
        .select({ id: applications.id })
        .from(applications)
        .where(eq(applications.gmailMessageId, message.id))
        .limit(1);
      if (already.length > 0) continue;

      // One message's failure (most likely a Groq call) shouldn't abort the whole
      // batch, and shouldn't get silently treated as "not a job email" either —
      // leaving it uninserted means the next sync run picks it back up as long as
      // it's still inside the JOB_QUERY newer_than window.
      try {
        // format: "full" (not "metadata") because the dashboard now shows the
        // whole message when you click into it, not just the list snippet.
        const full = await gmail.users.messages.get({
          userId: "me",
          id: message.id,
          format: "full",
        });

        const headers = full.data.payload?.headers ?? [];
        const subject = headers.find((h) => h.name === "Subject")?.value ?? "(no subject)";
        const from = headers.find((h) => h.name === "From")?.value ?? "";
        const snippet = full.data.snippet ?? "";
        const { text: extractedText, html: bodyHtml } = extractMessageContent(full.data.payload);
        const body = extractedText || snippet;
        const receivedAt = new Date(Number(full.data.internalDate ?? Date.now()));

        const category = await classifyEmail(subject, snippet);
        if (category === "Skip") continue;

        const company = extractCompany(from, subject);
        const fromEmail = extractEmail(from);
        const reminderDueAt = EXTRACT_DUE_DATE_FOR.includes(category as Category)
          ? await extractDueDate(subject, snippet, receivedAt)
          : null;

        await db.insert(applications).values({
          gmailMessageId: message.id,
          company,
          category,
          subject,
          snippet,
          body,
          bodyHtml,
          fromEmail,
          receivedAt,
          reminderDueAt,
        });
        result.inserted++;

        if (NOTIFY_ON_ARRIVAL.includes(category as Category)) {
          await sendTelegramMessage(
            `*${category}* — ${company}\n${subject}\n\n_${snippet.slice(0, 200)}_`
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`message ${message.id}: ${msg}`);
        console.error("[sync] failed on message", message.id, err);
      }
    }

    // Second pass: repeating "coming up" reminders. Only Interview, Assessment and
    // Offer rows are eligible (REMINDER_CATEGORIES) — Applied, Rejection, Reminder
    // and Verification emails never nudge. Each eligible row pings once every
    // REMINDER_INTERVAL_HOURS, up to MAX_REMINDERS_PER_APPLICATION times, then stops
    // for good. `reminderSent` is the terminal flag: cap reached, or event passed.
    const now = new Date();
    const dueSoonCutoff = new Date(now.getTime() + REMINDER_WINDOW_HOURS * 60 * 60 * 1000);
    const intervalMs = REMINDER_INTERVAL_HOURS * 60 * 60 * 1000;

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
      if (!app.reminderDueAt) continue;

      // Event is in the past: nothing left to remind about, close the row out.
      if (app.reminderDueAt <= now) {
        await db.update(applications).set({ reminderSent: true }).where(eq(applications.id, app.id));
        continue;
      }

      // Still further out than the window — leave it for a later run.
      if (app.reminderDueAt > dueSoonCutoff) continue;

      // Cap already hit (belt and braces; the update below closes the row too).
      if (app.reminderCount >= MAX_REMINDERS_PER_APPLICATION) {
        await db.update(applications).set({ reminderSent: true }).where(eq(applications.id, app.id));
        continue;
      }

      // Not enough time since the last nudge.
      if (app.lastReminderAt && now.getTime() - app.lastReminderAt.getTime() < intervalMs) continue;

      // A failed Telegram send must not abort the rest of the batch, and must not
      // bump the counter either — the row stays eligible for the next cron pass.
      const nextCount = app.reminderCount + 1;
      try {
        await sendTelegramMessage(
          `⏰ *${app.category} coming up* — ${app.company}\n${app.subject}\n` +
            `Due: ${app.reminderDueAt.toLocaleString()}\n` +
            `_Reminder ${nextCount} of ${MAX_REMINDERS_PER_APPLICATION}_`
        );
        await db
          .update(applications)
          .set({
            reminderCount: nextCount,
            lastReminderAt: now,
            reminderSent: nextCount >= MAX_REMINDERS_PER_APPLICATION,
          })
          .where(eq(applications.id, app.id));
        result.remindersSent++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`reminder ${app.id}: ${msg}`);
        console.error("[sync] reminder failed for application", app.id, err);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(message);
    console.error("[sync] failed", err);
    return NextResponse.json({ ok: false, ...result }, { status: 500 });
  }

  return NextResponse.json({ ok: true, ...result });
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
