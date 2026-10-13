// The owner's overrides and Review answers, against real SQL (PGlite).
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { createRequire } from "node:module";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import * as schema from "@/db/schema";
import { applications, jobApplications, linkExamples, reviewItems } from "@/db/schema";
import { linkPendingEmails } from "./store";
import { detachEmail, loadAppRows, mergeApplications, resolveReview, setStage, splitApplication } from "./actions";

const { pushSchema } = createRequire(import.meta.url)("drizzle-kit/api") as typeof import("drizzle-kit/api");

let db: ReturnType<typeof drizzle<typeof schema>>;
let n = 0;

beforeEach(async () => {
  db = drizzle(new PGlite(), { schema });
  await (await pushSchema(schema, db as never)).apply();
});

async function addEmail(over: Partial<typeof applications.$inferInsert> = {}) {
  n++;
  const [row] = await db
    .insert(applications)
    .values({ gmailMessageId: `a${n}`, company: "Cotiviti", role: "Gen AI Intern", category: "Applied", receivedAt: new Date(Date.UTC(2026, 8, 1, 12, n)), ...over })
    .returning();
  return row;
}
const link = () => linkPendingEmails(db as never, { ownerEmail: null });
const appsNow = () => db.select().from(jobApplications);
const emailRow = async (id: number) => (await db.select().from(applications).where(eq(applications.id, id)))[0];

describe("loadAppRows", () => {
  test("returns one row per application with its email count and review flag", async () => {
    await addEmail({ role: "Gen AI Intern" });
    await addEmail({ role: "Data Scientist" });
    await addEmail({ category: "Interview", role: null }); // ambiguous -> review
    await link();
    const rows = await loadAppRows(db as never);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.emailCount === 1)).toBe(true);
  });

  test("marks applications that are candidates of an open review item", async () => {
    await addEmail({ role: "Gen AI Intern" });
    await addEmail({ role: "Data Scientist" });
    await addEmail({ category: "Interview", role: null });
    await link();
    const rows = await loadAppRows(db as never);
    expect(rows.every((r) => r.needsReview)).toBe(true);
  });
});

describe("setStage", () => {
  test("sets the stage, flags it manual, and records a labelled example", async () => {
    await addEmail();
    await link();
    const [app] = await appsNow();
    await setStage(db as never, app.id, "Interview");
    const [after] = await appsNow();
    expect(after.stage).toBe("Interview");
    expect(after.flags).toContain("manual-stage");
    expect((await db.select().from(linkExamples))[0]).toMatchObject({ kind: "stage", toApplicationId: app.id });
  });
});

describe("detachEmail", () => {
  test("takes the email back out of its application and puts it in Review", async () => {
    const a = await addEmail({ threadId: "t1" });
    const b = await addEmail({ threadId: "t2", category: "Assessment", role: "Gen AI Intern" });
    await link();
    await detachEmail(db as never, b.id);
    expect(await emailRow(b.id)).toMatchObject({ linkState: "review", jobApplicationId: null });
    expect((await db.select().from(reviewItems).where(eq(reviewItems.emailId, b.id))).length).toBe(1);
    expect(await emailRow(a.id)).toMatchObject({ linkState: "linked" });
    const [app] = await appsNow();
    expect(app.stage).toBe("Applied"); // rebuilt without the assessment email
    expect((await db.select().from(linkExamples))[0]).toMatchObject({ kind: "detach", emailId: b.id });
  });

  test("deletes an application whose only email was detached", async () => {
    const only = await addEmail();
    await link();
    await detachEmail(db as never, only.id);
    expect(await appsNow()).toHaveLength(0);
  });

  test("moves the whole thread, so one conversation never straddles two applications", async () => {
    await addEmail({ threadId: "t1" });
    const x = await addEmail({ threadId: "t1", category: "Interview", role: null });
    const y = await addEmail({ threadId: "t1", category: "Interview", role: null });
    await link();
    await detachEmail(db as never, x.id);
    expect((await emailRow(y.id)).linkState).toBe("review");
  });
});

describe("splitApplication", () => {
  test("moves chosen emails into a new application and rebuilds both stages", async () => {
    await addEmail({ threadId: "t1", role: "Gen AI Intern" });
    const wrong = await addEmail({ threadId: "t2", category: "Interview", role: "Gen AI Intern", interviewRound: 2 });
    await link();
    const [app] = await appsNow();
    expect(app.stage).toBe("Interview");

    const newId = await splitApplication(db as never, app.id, [wrong.id], { role: "Data Scientist I" });
    const apps = await appsNow();
    expect(apps).toHaveLength(2);
    expect(apps.find((x) => x.id === app.id)).toMatchObject({ stage: "Applied", interviewRound: 0 });
    expect(apps.find((x) => x.id === newId)).toMatchObject({ stage: "Interview", interviewRound: 2, role: "Data Scientist I" });
    expect((await emailRow(wrong.id)).jobApplicationId).toBe(newId);
    expect((await db.select().from(linkExamples)).map((e) => e.kind)).toContain("split");
  });

  test("later mail in the corrected thread follows the correction", async () => {
    await addEmail({ threadId: "t1", role: "Gen AI Intern" });
    const wrong = await addEmail({ threadId: "t2", category: "Interview", role: "Gen AI Intern" });
    await link();
    const [app] = await appsNow();
    const newId = await splitApplication(db as never, app.id, [wrong.id], { role: "Data Scientist I" });
    const later = await addEmail({ threadId: "t2", category: "Offer", role: null });
    await link();
    expect((await emailRow(later.id)).jobApplicationId).toBe(newId);
  });
});

describe("mergeApplications", () => {
  test("moves every email into the target, removes the source, and keeps the earliest applied date", async () => {
    const first = await addEmail({ role: "Gen AI Intern", receivedAt: new Date("2026-09-01T00:00:00Z") });
    const second = await addEmail({ role: "Machine Learning Intern", receivedAt: new Date("2026-09-10T00:00:00Z") });
    await link();
    const [one, two] = (await appsNow()).sort((a, b) => a.id - b.id);
    await mergeApplications(db as never, two.id, one.id);
    const apps = await appsNow();
    expect(apps).toHaveLength(1);
    expect(apps[0].appliedAt).toEqual(new Date("2026-09-01T00:00:00Z"));
    expect((await emailRow(second.id)).jobApplicationId).toBe(one.id);
    expect((await emailRow(first.id)).jobApplicationId).toBe(one.id);
    expect((await db.select().from(linkExamples)).map((e) => e.kind)).toContain("merge");
  });

  test("refuses to merge an application into itself", async () => {
    await addEmail();
    await link();
    const [app] = await appsNow();
    await expect(mergeApplications(db as never, app.id, app.id)).rejects.toThrow();
  });
});

describe("resolveReview", () => {
  async function ambiguous() {
    await addEmail({ role: "Gen AI Intern" });
    await addEmail({ role: "Data Scientist" });
    const e = await addEmail({ category: "Interview", role: null });
    await link();
    const [item] = await db.select().from(reviewItems);
    return { e, item };
  }

  test("attaching to a chosen application links the email, advances that application, and closes the item", async () => {
    const { e, item } = await ambiguous();
    const target = (await appsNow()).find((a) => a.role === "Gen AI Intern")!;
    await resolveReview(db as never, item.id, { type: "attach", applicationId: target.id });
    expect(await emailRow(e.id)).toMatchObject({ linkState: "linked", jobApplicationId: target.id });
    expect((await appsNow()).find((a) => a.id === target.id)!.stage).toBe("Interview");
    expect((await db.select().from(reviewItems))[0].resolvedAt).not.toBeNull();
    expect((await db.select().from(linkExamples))[0]).toMatchObject({ kind: "review", toApplicationId: target.id });
  });

  test("'new application' creates one from the email's employer and role", async () => {
    const { e, item } = await ambiguous();
    await resolveReview(db as never, item.id, { type: "new" });
    expect(await appsNow()).toHaveLength(3);
    expect((await emailRow(e.id)).linkState).toBe("linked");
  });

  test("'not a job email' ignores it and never touches an application", async () => {
    const { e, item } = await ambiguous();
    await resolveReview(db as never, item.id, { type: "ignore" });
    expect(await emailRow(e.id)).toMatchObject({ linkState: "ignored", jobApplicationId: null });
    expect((await appsNow()).every((a) => a.stage === "Applied")).toBe(true);
  });

  test("an already resolved item cannot be resolved twice", async () => {
    const { item } = await ambiguous();
    await resolveReview(db as never, item.id, { type: "ignore" });
    await expect(resolveReview(db as never, item.id, { type: "ignore" })).rejects.toThrow();
  });
});
