// Counts failed classifications per Gmail message, against real SQL (PGlite), and gives
// up on a message at the limit so it stops costing an LLM call on every run.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { createRequire } from "node:module";
import { beforeEach, describe, expect, test } from "vitest";
import * as schema from "@/db/schema";
import { ignoredMessages, messageFailures } from "@/db/schema";
import { STATEMENTS } from "../../../scripts/lib/retryLimitStatements.mjs";
import { MAX_CLASSIFY_FAILURES, recordClassifyFailures } from "./retryLimit";

const { pushSchema } = createRequire(import.meta.url)("drizzle-kit/api") as typeof import("drizzle-kit/api");

let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(async () => {
  db = drizzle(new PGlite(), { schema });
  await (await pushSchema(schema, db as never)).apply();
});

const failure = (messageId: string, message = `message ${messageId}: could not parse verdict`) => ({
  messageId,
  message,
});

const ignoredIds = async () =>
  (await db.select().from(ignoredMessages)).map((row) => row.gmailMessageId).sort();

describe("recordClassifyFailures", () => {
  test("the limit is three failures", () => {
    expect(MAX_CLASSIFY_FAILURES).toBe(3);
  });

  test("a first failure is counted and the message is left for the next run", async () => {
    const gaveUp = await recordClassifyFailures(db as never, [failure("a")]);

    expect(gaveUp).toEqual([]);
    expect(await ignoredIds()).toEqual([]);
    const [row] = await db.select().from(messageFailures);
    expect(row).toMatchObject({ gmailMessageId: "a", failures: 1 });
  });

  test("the third failure banks the message as ignored and returns its id", async () => {
    await recordClassifyFailures(db as never, [failure("a")]);
    await recordClassifyFailures(db as never, [failure("a")]);
    const gaveUp = await recordClassifyFailures(db as never, [failure("a", "message a: last reason")]);

    expect(gaveUp).toEqual(["a"]);
    expect(await ignoredIds()).toEqual(["a"]);
    const [row] = await db.select().from(messageFailures);
    expect(row).toMatchObject({ failures: 3, lastError: "message a: last reason" });
  });

  test("counts each message on its own", async () => {
    await recordClassifyFailures(db as never, [failure("a"), failure("b")]);
    await recordClassifyFailures(db as never, [failure("a")]);
    const gaveUp = await recordClassifyFailures(db as never, [failure("a"), failure("b")]);

    expect(gaveUp).toEqual(["a"]);
    expect(await ignoredIds()).toEqual(["a"]);
  });

  test("a message already in ignored_messages is not an error", async () => {
    await db.insert(ignoredMessages).values({ gmailMessageId: "a" });
    for (let i = 0; i < MAX_CLASSIFY_FAILURES - 1; i++) await recordClassifyFailures(db as never, [failure("a")]);

    await expect(recordClassifyFailures(db as never, [failure("a")])).resolves.toEqual(["a"]);
    expect(await ignoredIds()).toEqual(["a"]);
  });

  test("nothing to record makes no query", async () => {
    await expect(recordClassifyFailures({} as never, [])).resolves.toEqual([]);
  });

  test("a very long error text is clipped before it is stored", async () => {
    await recordClassifyFailures(db as never, [failure("a", "x".repeat(10_000))]);

    const [row] = await db.select().from(messageFailures);
    expect(row.lastError!.length).toBeLessThanOrEqual(500);
  });
});

describe("migrate-retry-limit", () => {
  test("creates the table the code uses, and running it twice is safe", async () => {
    const pg = new PGlite();
    for (const statement of [...STATEMENTS, ...STATEMENTS] as string[]) await pg.exec(statement);
    await pg.exec(`CREATE TABLE ignored_messages (
      id serial PRIMARY KEY,
      gmail_message_id text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    const migrated = drizzle(pg, { schema });

    for (let i = 0; i < MAX_CLASSIFY_FAILURES; i++) await recordClassifyFailures(migrated as never, [failure("a")]);

    expect(await migrated.select().from(messageFailures)).toMatchObject([{ gmailMessageId: "a", failures: 3 }]);
  });
});
