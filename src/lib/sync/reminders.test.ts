// The "due soon" pass, against real SQL (PGlite) with a fake Telegram sender.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { createRequire } from "node:module";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import * as schema from "@/db/schema";
import { applications } from "@/db/schema";
import { MAX_REMINDERS_PER_APPLICATION, REMINDER_INTERVAL_HOURS } from "@/lib/constants";
import { runReminderPass } from "./reminders";

const { pushSchema } = createRequire(import.meta.url)("drizzle-kit/api") as typeof import("drizzle-kit/api");

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-10-21T12:00:00Z");
const DUE = new Date(NOW.getTime() + 24 * HOUR);
const inHours = (h: number) => new Date(NOW.getTime() + h * HOUR);
const counter = (n: number) => `Reminder ${n} of ${MAX_REMINDERS_PER_APPLICATION}`;

let db: ReturnType<typeof drizzle<typeof schema>>;
let sent: string[];
let n = 0;

beforeEach(async () => {
  db = drizzle(new PGlite(), { schema });
  await (await pushSchema(schema, db as never)).apply();
  sent = [];
});

// A real row: an Assessment mail from a recruiter, due tomorrow.
async function addEmail(over: Partial<typeof applications.$inferInsert> = {}) {
  n++;
  const [row] = await db
    .insert(applications)
    .values({
      gmailMessageId: `r${n}`,
      company: "Amazon Web Services",
      category: "Assessment",
      subject: "Re: AGS - Tech Solutions Architect full-time position - Next Steps!",
      fromEmail: "recruiter@aws.example",
      receivedAt: new Date(Date.UTC(2026, 9, 16, 12, n)),
      reminderDueAt: DUE,
      ...over,
    })
    .returning();
  return row;
}

const row = async (id: number) => (await db.select().from(applications).where(eq(applications.id, id)))[0];

async function tick(now: Date, io: { send?: (text: string) => Promise<void>; hasTimeLeft?: () => boolean } = {}) {
  const result = { remindersSent: 0, ranOutOfTime: false, errors: [] as string[] };
  await runReminderPass(
    db as never,
    {
      now,
      hasTimeLeft: io.hasTimeLeft ?? (() => true),
      send: io.send ?? (async (text) => void sent.push(text)),
    },
    result,
  );
  return result;
}

describe("runReminderPass: the cadence of one email", () => {
  test("sends the first reminder for an event inside the window and records it", async () => {
    const a = await addEmail();

    const result = await tick(NOW);

    expect(result.remindersSent).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(counter(1));
    expect(await row(a.id)).toMatchObject({ reminderCount: 1, reminderSent: false, lastReminderAt: NOW });
  });

  test("stays quiet inside the interval and sends again after it", async () => {
    await addEmail();

    await tick(NOW);
    await tick(inHours(REMINDER_INTERVAL_HOURS - 1));
    expect(sent).toHaveLength(1);

    await tick(inHours(REMINDER_INTERVAL_HOURS));
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain(counter(2));
  });

  test("the last allowed reminder closes the row, and nothing more is sent", async () => {
    const a = await addEmail({ reminderDueAt: inHours(40) });

    for (let i = 0; i < MAX_REMINDERS_PER_APPLICATION; i++) await tick(inHours(i * REMINDER_INTERVAL_HOURS));
    expect(sent).toHaveLength(MAX_REMINDERS_PER_APPLICATION);
    expect(await row(a.id)).toMatchObject({ reminderCount: MAX_REMINDERS_PER_APPLICATION, reminderSent: true });

    await tick(inHours(MAX_REMINDERS_PER_APPLICATION * REMINDER_INTERVAL_HOURS));
    expect(sent).toHaveLength(MAX_REMINDERS_PER_APPLICATION);
  });

  test("an event in the past is closed without a message", async () => {
    const a = await addEmail({ reminderDueAt: inHours(-1) });

    await tick(NOW);

    expect(sent).toHaveLength(0);
    expect((await row(a.id)).reminderSent).toBe(true);
  });

  test("a job alert filed as Screening is never reminded about", async () => {
    const a = await addEmail({
      category: "Screening",
      fromEmail: "alerts@ziprecruiter.com",
      subject: "$145/hr Embedded Software Engineers job in Fairview, CO",
    });

    await tick(NOW);

    expect(sent).toHaveLength(0);
    expect(await row(a.id)).toMatchObject({ reminderCount: 0, reminderSent: false });
  });

  test("a failed send gives the count back and reports the error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const a = await addEmail();

    const result = await tick(NOW, { send: async () => Promise.reject(new Error("telegram down")) });

    expect(result.remindersSent).toBe(0);
    expect(result.errors).toEqual([`reminder ${a.id}: telegram down`]);
    expect(await row(a.id)).toMatchObject({ reminderCount: 0, lastReminderAt: null, reminderSent: false });
  });

  test("stops and says so when the run is out of time", async () => {
    const a = await addEmail();

    const result = await tick(NOW, { hasTimeLeft: () => false });

    expect(result.ranOutOfTime).toBe(true);
    expect(sent).toHaveLength(0);
    expect((await row(a.id)).reminderCount).toBe(0);
  });
});

// Real rows from 21 October: five replies in one conversation with Amazon Web Services, all
// linked to one Application and all due on the same day. Each of them sent its own reminder,
// so one interview produced a message per email, every 8 hours.
describe("runReminderPass: one event sends one reminder, however many emails name it", () => {
  test("four emails of one Application with the same due date send one message", async () => {
    const emails = [];
    for (let i = 0; i < 4; i++) emails.push(await addEmail({ jobApplicationId: 1282 }));

    await tick(NOW);

    expect(sent).toHaveLength(1);
    const rows = await Promise.all(emails.map((e) => row(e.id)));
    expect(rows.filter((r) => r.reminderCount === 1)).toHaveLength(1);
    expect(rows.filter((r) => r.reminderSent)).toHaveLength(3);
  });

  test("the event keeps one cadence: quiet inside the interval, then the second reminder", async () => {
    for (let i = 0; i < 4; i++) await addEmail({ jobApplicationId: 1282 });

    await tick(NOW);
    await tick(inHours(1));
    expect(sent).toHaveLength(1);

    await tick(inHours(REMINDER_INTERVAL_HOURS));
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain(counter(2));
  });

  test("emails with no Application but the same thread send one message", async () => {
    for (let i = 0; i < 3; i++) await addEmail({ jobApplicationId: null, threadId: "1a1377fb" });

    await tick(NOW);

    expect(sent).toHaveLength(1);
  });

  test("the email that already sent the most keeps the event, so the count never restarts", async () => {
    const old = await addEmail({
      jobApplicationId: 1282,
      reminderCount: 3,
      lastReminderAt: inHours(-9),
    });
    const late = await addEmail({ jobApplicationId: 1282 });

    await tick(NOW);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(counter(4));
    expect(await row(old.id)).toMatchObject({ reminderCount: 4, reminderSent: true });
    expect(await row(late.id)).toMatchObject({ reminderCount: 0, reminderSent: true });
  });

  test("a late email for an event that used all its reminders stays silent", async () => {
    await addEmail({ jobApplicationId: 1282, reminderCount: MAX_REMINDERS_PER_APPLICATION, reminderSent: true, lastReminderAt: inHours(-9) });
    const late = await addEmail({ jobApplicationId: 1282 });

    await tick(NOW);

    expect(sent).toHaveLength(0);
    expect((await row(late.id)).reminderSent).toBe(true);
  });

  // The limits: these stay separate events, because they can be different events.
  test("two due dates in one Application are two events", async () => {
    await addEmail({ jobApplicationId: 1282, reminderDueAt: DUE });
    await addEmail({ jobApplicationId: 1282, reminderDueAt: inHours(30) });

    await tick(NOW);

    expect(sent).toHaveLength(2);
  });

  test("different Applications with the same due date are two events", async () => {
    await addEmail({ jobApplicationId: 1 });
    await addEmail({ jobApplicationId: 2 });

    await tick(NOW);

    expect(sent).toHaveLength(2);
  });

  test("emails with no Application and no thread cannot be matched, so each sends its own", async () => {
    await addEmail({ jobApplicationId: null, threadId: null });
    await addEmail({ jobApplicationId: null, threadId: null });

    await tick(NOW);

    expect(sent).toHaveLength(2);
  });
});
