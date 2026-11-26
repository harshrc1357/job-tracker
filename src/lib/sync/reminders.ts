// The "due soon" pass of the sync: a Telegram message for mail that names an upcoming event
// (an interview, an assessment deadline). Kept out of the route so it can be tested against a
// real database with a fake sender.

import { and, eq, gt, inArray, isNotNull, or } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { applications } from "@/db/schema";
import { REMINDER_CATEGORIES } from "@/lib/categories";
import { MAX_COMPANY_CHARS, MAX_REMINDERS_PER_APPLICATION, MAX_SUBJECT_CHARS } from "@/lib/constants";
import { canPing } from "@/lib/link/kindOf";
import { decideReminder } from "@/lib/reminderPolicy";
import { clip, escapeMarkdownV2 } from "@/lib/telegram";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PgDatabase<any, any>;

export type ReminderIo = {
  now: Date;
  hasTimeLeft: () => boolean;
  send: (text: string) => Promise<void>;
};

// The parts of the sync result this pass writes to.
export type ReminderResult = {
  remindersSent: number;
  ranOutOfTime: boolean;
  errors: string[];
};

type Email = typeof applications.$inferSelect;

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

// One event is one Application (one thread while an email has no Application) at one due date.
// Five replies in a conversation about the same interview are one event, not five.
function conversationOf(email: Email): string | null {
  if (email.jobApplicationId !== null) return `application:${email.jobApplicationId}`;
  if (email.threadId) return `thread:${email.threadId}`;
  return null;
}

// An email with no due date, or in no conversation we can name, is an event on its own.
function eventKey(email: Email): string {
  const conversation = conversationOf(email);
  if (!conversation || !email.reminderDueAt) return `email:${email.id}`;
  return `${conversation}|${email.reminderDueAt.getTime()}`;
}

// The email that has already sent the most owns the event, so a sequence never starts over.
// Among equals the newest email owns it.
const owns = (a: Email, b: Email) =>
  b.reminderCount - a.reminderCount ||
  (b.lastReminderAt?.getTime() ?? 0) - (a.lastReminderAt?.getTime() ?? 0) ||
  b.receivedAt.getTime() - a.receivedAt.getTime() ||
  b.id - a.id;

function groupByEvent(emails: readonly Email[]): { owner: Email; others: Email[] }[] {
  const events = new Map<string, Email[]>();
  for (const email of emails) {
    const key = eventKey(email);
    events.set(key, [...(events.get(key) ?? []), email]);
  }
  return [...events.values()].map((members) => {
    const [owner, ...others] = [...members].sort(owns);
    return { owner, others };
  });
}

export async function runReminderPass(db: Db, io: ReminderIo, result: ReminderResult): Promise<void> {
  const { now } = io;

  // Emails that already sent all their reminders stay in the list while the event is ahead,
  // so a late email about the same event does not start the sequence again.
  const rows = await db
    .select()
    .from(applications)
    .where(
      and(
        isNotNull(applications.reminderDueAt),
        inArray(applications.category, REMINDER_CATEGORIES),
        or(
          eq(applications.reminderSent, false),
          and(gt(applications.reminderCount, 0), gt(applications.reminderDueAt, now))
        )
      )
    );

  // A job alert filed as Screening that was stored earlier must not be reminded about either.
  for (const { owner: app, others } of groupByEvent(rows.filter(canPing))) {
    if (!io.hasTimeLeft()) {
      result.ranOutOfTime = true;
      return;
    }

    // Only the owner sends. The other emails of the event stop for good.
    const silenced = others.filter((email) => !email.reminderSent).map((email) => email.id);
    if (silenced.length > 0) {
      await db.update(applications).set({ reminderSent: true }).where(inArray(applications.id, silenced));
    }
    if (app.reminderSent) continue;

    const decision = decideReminder(app, now);
    if (decision.action === "skip") continue;

    if (decision.action === "close") {
      await db.update(applications).set({ reminderSent: true }).where(eq(applications.id, app.id));
      continue;
    }

    // Claim the nudge before sending it, with a compare-and-swap on the count we
    // just read. This is the only thing standing between two overlapping runs and a
    // duplicate ping: the insert path is protected by onConflictDoNothing, but this
    // one was a plain read-then-write, so both runs could see reminderCount 0, both
    // send, and both write 1.
    //
    // Whichever run's UPDATE lands first changes the count, so the other's WHERE no
    // longer matches, it gets zero rows back, and it sends nothing.
    const claimed = await db
      .update(applications)
      .set({
        reminderCount: decision.nextCount,
        lastReminderAt: now,
        reminderSent: decision.isFinal,
      })
      .where(and(eq(applications.id, app.id), eq(applications.reminderCount, app.reminderCount)))
      .returning({ id: applications.id });

    // Another run got there first. Not an error, and not worth reporting.
    if (claimed.length === 0) continue;

    try {
      await io.send(formatReminderMessage(app, decision.nextCount));
      result.remindersSent++;
    } catch (err) {
      // Release the claim. Claiming before sending is what stops a double ping, but
      // it would otherwise burn a count on a nudge that never arrived — the exact
      // thing the old send-then-record order existed to prevent. Rolling back keeps
      // both properties: no duplicates, and no silently spent reminder.
      try {
        await db
          .update(applications)
          .set({
            reminderCount: app.reminderCount,
            lastReminderAt: app.lastReminderAt,
            reminderSent: false,
          })
          .where(eq(applications.id, app.id));
      } catch (rollbackErr) {
        // Worst case the row keeps a count it did not use, costing one nudge out of
        // MAX_REMINDERS_PER_APPLICATION. Reported, not thrown — the send failure
        // below is the more useful error to surface.
        console.error("[sync] failed to release reminder claim", app.id, rollbackErr);
      }

      result.errors.push(`reminder ${app.id}: ${describe(err)}`);
      console.error("[sync] reminder failed for application", app.id, err);
    }
  }
}

function formatReminderMessage(app: typeof applications.$inferSelect, nextCount: number): string {
  const category = escapeMarkdownV2(app.category);
  const company = escapeMarkdownV2(clip(app.company, MAX_COMPANY_CHARS));
  const subject = escapeMarkdownV2(clip(app.subject ?? "", MAX_SUBJECT_CHARS));
  const due = escapeMarkdownV2(app.reminderDueAt?.toLocaleString() ?? "");
  const counter = escapeMarkdownV2(`Reminder ${nextCount} of ${MAX_REMINDERS_PER_APPLICATION}`);
  return `⏰ *${category} coming up* — ${company}\n${subject}\nDue: ${due}\n_${counter}_`;
}
