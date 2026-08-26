import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNotNull } from "drizzle-orm";
import { getGmailClient } from "@/lib/gmail";
import { db } from "@/db/client";
import { applications } from "@/db/schema";
import { classifyEmail } from "@/lib/classify";
import { extractDueDate } from "@/lib/extractDueDate";
import { sendTelegramMessage } from "@/lib/telegram";
import { EXTRACT_DUE_DATE_FOR, NOTIFY_ON_ARRIVAL, type Category } from "@/lib/categories";

export const runtime = "nodejs";
export const maxDuration = 60;

// Cast a slightly wide net — the classifier (keyword rules + LLM fallback) is the real
// filter. This query just keeps Gmail from handing back the entire inbox.
const JOB_QUERY =
  'newer_than:2d (application OR interview OR assessment OR offer OR "thank you for applying" OR recruiting OR careers OR hiring)';

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const result = { checked: 0, inserted: 0, remindersSent: 0, errors: [] as string[] };

  try {
    const gmail = await getGmailClient();
    const list = await gmail.users.messages.list({ userId: "me", q: JOB_QUERY, maxResults: 25 });
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

      const full = await gmail.users.messages.get({
        userId: "me",
        id: message.id,
        format: "metadata",
        metadataHeaders: ["Subject", "From", "Date"],
      });

      const headers = full.data.payload?.headers ?? [];
      const subject = headers.find((h) => h.name === "Subject")?.value ?? "(no subject)";
      const from = headers.find((h) => h.name === "From")?.value ?? "";
      const snippet = full.data.snippet ?? "";
      const receivedAt = new Date(Number(full.data.internalDate ?? Date.now()));

      const category = await classifyEmail(subject, snippet);
      if (category === "Skip") continue;

      const company = extractCompany(from, subject);
      const reminderDueAt = EXTRACT_DUE_DATE_FOR.includes(category as Category)
        ? await extractDueDate(subject, snippet, receivedAt)
        : null;

      await db.insert(applications).values({
        gmailMessageId: message.id,
        company,
        category,
        subject,
        snippet,
        receivedAt,
        reminderDueAt,
      });
      result.inserted++;

      if (NOTIFY_ON_ARRIVAL.includes(category as Category)) {
        await sendTelegramMessage(
          `*${category}* — ${company}\n${subject}\n\n_${snippet.slice(0, 200)}_`
        );
      }
    }

    // Second pass: anything with a known due date inside the next 24h that hasn't
    // been re-pinged yet gets a "coming up" reminder.
    const dueSoonCutoff = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const pending = await db
      .select()
      .from(applications)
      .where(and(isNotNull(applications.reminderDueAt), eq(applications.reminderSent, false)));

    for (const app of pending) {
      if (!app.reminderDueAt) continue;
      if (app.reminderDueAt > dueSoonCutoff || app.reminderDueAt < new Date()) continue;

      await sendTelegramMessage(
        `⏰ *${app.category} coming up* — ${app.company}\n${app.subject}\nDue: ${app.reminderDueAt.toLocaleString()}`
      );
      await db.update(applications).set({ reminderSent: true }).where(eq(applications.id, app.id));
      result.remindersSent++;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(message);
    console.error("[sync] failed", err);
    return NextResponse.json({ ok: false, ...result }, { status: 500 });
  }

  return NextResponse.json({ ok: true, ...result });
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
