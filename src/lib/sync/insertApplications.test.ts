// Stores a batch of synced emails, against real SQL (PGlite). Postgres is the judge of
// which rows are refusable, so the test uses a NUL byte, which it rejects in text.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { createRequire } from "node:module";
import { beforeEach, describe, expect, test } from "vitest";
import * as schema from "@/db/schema";
import { applications } from "@/db/schema";
import { insertApplications } from "./insertApplications";

const { pushSchema } = createRequire(import.meta.url)("drizzle-kit/api") as typeof import("drizzle-kit/api");

let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(async () => {
  db = drizzle(new PGlite(), { schema });
  await (await pushSchema(schema, db as never)).apply();
});

const row = (id: string, over: Partial<typeof applications.$inferInsert> = {}): typeof applications.$inferInsert => ({
  gmailMessageId: id,
  company: "Acme",
  category: "Applied",
  receivedAt: new Date("2026-10-01T12:00:00Z"),
  ...over,
});

describe("insertApplications", () => {
  test("stores a clean batch in one go and reports every id", async () => {
    const errors: string[] = [];
    const inserted = await insertApplications(db as never, [row("a"), row("b")], errors);

    expect(inserted.map((r) => r.gmailMessageId).sort()).toEqual(["a", "b"]);
    expect(errors).toEqual([]);
  });

  test("one row Postgres refuses does not stop the others being stored", async () => {
    const errors: string[] = [];
    const inserted = await insertApplications(db as never, [row("good-1"), row("bad", { subject: "has\u0000nul" }), row("good-2")], errors);

    expect(inserted.map((r) => r.gmailMessageId).sort()).toEqual(["good-1", "good-2"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("bad");
    expect(await db.select().from(applications)).toHaveLength(2);
  });

  test("a message that is already stored is skipped, not reported as an error", async () => {
    await db.insert(applications).values(row("dup"));
    const errors: string[] = [];
    const inserted = await insertApplications(db as never, [row("dup"), row("new")], errors);

    expect(inserted.map((r) => r.gmailMessageId)).toEqual(["new"]);
    expect(errors).toEqual([]);
  });
});
