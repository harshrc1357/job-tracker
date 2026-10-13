// Integration test of the DB adapter against a real in-process Postgres (PGlite), so
// idempotency and "nothing half-written" are checked against actual SQL, not a mock.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { createRequire } from "node:module";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import * as schema from "@/db/schema";
import { applications, jobApplications, reviewItems } from "@/db/schema";
import { linkPendingEmails } from "./store";

// drizzle-kit ships CJS; importing it through vite's ESM transform breaks its fs requires.
const { pushSchema } = createRequire(import.meta.url)("drizzle-kit/api") as typeof import("drizzle-kit/api");

let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(async () => {
  db = drizzle(new PGlite(), { schema });
  const { apply } = await pushSchema(schema, db as never);
  await apply();
});

let n = 0;
async function addEmail(over: Partial<typeof applications.$inferInsert> = {}) {
  n++;
  const [row] = await db
    .insert(applications)
    .values({
      gmailMessageId: `m${n}`,
      company: "Cotiviti",
      role: "Data Scientist I",
      category: "Applied",
      receivedAt: new Date(Date.UTC(2026, 8, 1, 12, n)),
      ...over,
    })
    .returning();
  return row;
}

describe("linkPendingEmails", () => {
  test("creates an application for an Applied email and links the email to it", async () => {
    const e = await addEmail({ threadId: "t1" });
    const summary = await linkPendingEmails(db as never, { ownerEmail: "me@example.com" });
    const [apps] = [await db.select().from(jobApplications)];
    const [email] = await db.select().from(applications).where(eq(applications.id, e.id));
    expect(summary).toMatchObject({ created: 1, review: 0 });
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({ employer: "Cotiviti", role: "Data Scientist I", stage: "Applied", status: "open" });
    expect(email).toMatchObject({ linkState: "linked", jobApplicationId: apps[0].id });
  });

  test("running it twice changes nothing the second time (scenario 42)", async () => {
    await addEmail({ threadId: "t1" });
    await addEmail({ threadId: "t1", category: "Interview", role: null, interviewRound: 2 });
    await linkPendingEmails(db as never, { ownerEmail: null });
    const before = await db.select().from(jobApplications);
    const second = await linkPendingEmails(db as never, { ownerEmail: null });
    const after = await db.select().from(jobApplications);
    expect(second).toMatchObject({ processed: 0 });
    expect(after).toEqual(before);
    expect(after[0]).toMatchObject({ stage: "Interview", interviewRound: 2 });
  });

  test("30 Applied emails in one run make 30 applications and 0 review items (scenario 41)", async () => {
    for (let i = 0; i < 30; i++) await addEmail({ company: `Company ${i}`, role: "Software Engineer" });
    const summary = await linkPendingEmails(db as never, { ownerEmail: null });
    expect(summary).toMatchObject({ created: 30, review: 0 });
    expect(await db.select().from(jobApplications)).toHaveLength(30);
    expect(await db.select().from(reviewItems)).toHaveLength(0);
  });

  test("an ambiguous email becomes a review item pointing at its candidates, and is not relinked", async () => {
    await addEmail({ role: "Data Scientist I" });
    await addEmail({ role: "ML Engineer" });
    const e = await addEmail({ category: "Interview", role: null });
    await linkPendingEmails(db as never, { ownerEmail: null });
    const [email] = await db.select().from(applications).where(eq(applications.id, e.id));
    const items = await db.select().from(reviewItems);
    expect(email).toMatchObject({ linkState: "review", jobApplicationId: null });
    expect(items).toHaveLength(1);
    expect(items[0].emailId).toBe(e.id);
    expect((items[0].candidates as unknown[]).length).toBe(2);

    await linkPendingEmails(db as never, { ownerEmail: null });
    expect(await db.select().from(reviewItems)).toHaveLength(1);
  });

  test("a roleless rejection with two open applications closes neither", async () => {
    await addEmail({ role: "Data Scientist I" });
    await addEmail({ role: "ML Engineer" });
    await addEmail({ category: "Rejection", role: null });
    await linkPendingEmails(db as never, { ownerEmail: null });
    const apps = await db.select().from(jobApplications);
    expect(apps.every((a) => a.status === "open")).toBe(true);
  });

  test("a later batch links against applications created by an earlier batch", async () => {
    await addEmail({ threadId: "t9" });
    await linkPendingEmails(db as never, { ownerEmail: null });
    const e = await addEmail({ threadId: "t9", category: "Assessment", role: null });
    await linkPendingEmails(db as never, { ownerEmail: null });
    const [email] = await db.select().from(applications).where(eq(applications.id, e.id));
    const apps = await db.select().from(jobApplications);
    expect(apps).toHaveLength(1);
    expect(email.jobApplicationId).toBe(apps[0].id);
    expect(apps[0].stage).toBe("Assessment");
  });

  test("my own reply is recognised by the owner address and never moves the stage", async () => {
    await addEmail({ threadId: "t5" });
    await addEmail({ threadId: "t5", category: "Interview", role: null, fromEmail: "Me <me@example.com>" });
    await linkPendingEmails(db as never, { ownerEmail: "me@example.com" });
    const [app] = await db.select().from(jobApplications);
    expect(app.stage).toBe("Applied");
  });

  test("verification mail is marked ignored and never creates an application", async () => {
    await addEmail({ category: "Verification" });
    await linkPendingEmails(db as never, { ownerEmail: null });
    const [email] = await db.select().from(applications);
    expect(email.linkState).toBe("ignored");
    expect(await db.select().from(jobApplications)).toHaveLength(0);
  });

  test("can be scoped to specific Gmail message ids, leaving older unlinked history alone", async () => {
    await addEmail({ gmailMessageId: "old-1", company: "Old Co" });
    await addEmail({ gmailMessageId: "new-1", company: "New Co" });
    const summary = await linkPendingEmails(db as never, { ownerEmail: null, messageIds: ["new-1"] });
    const apps = await db.select().from(jobApplications);
    expect(summary.processed).toBe(1);
    expect(apps.map((a) => a.employer)).toEqual(["New Co"]);
  });

  test("can be limited to mail received since a date, so history outside the window stays unlinked", async () => {
    await addEmail({ company: "Ancient Co", receivedAt: new Date("2026-01-01T00:00:00Z") });
    await addEmail({ company: "Recent Co", receivedAt: new Date("2026-09-20T00:00:00Z") });
    await linkPendingEmails(db as never, { ownerEmail: null, since: new Date("2026-08-01T00:00:00Z") });
    expect((await db.select().from(jobApplications)).map((a) => a.employer)).toEqual(["Recent Co"]);
  });

  test("respects the batch limit and leaves the rest for the next run", async () => {
    for (let i = 0; i < 5; i++) await addEmail({ company: `C${i}` });
    const first = await linkPendingEmails(db as never, { ownerEmail: null, limit: 3 });
    const second = await linkPendingEmails(db as never, { ownerEmail: null, limit: 3 });
    expect(first.processed).toBe(3);
    expect(second.processed).toBe(2);
  });
});
