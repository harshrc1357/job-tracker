// The production migration is hand-written SQL (not drizzle-kit push), so it can drift
// from src/db/schema.ts without any type error. This applies it to a database shaped
// like the live one BEFORE the change, with real rows, and then runs the linker on it.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, test } from "vitest";
import * as schema from "@/db/schema";
import { applications, jobApplications } from "@/db/schema";
import { STATEMENTS } from "../../../scripts/lib/linkingStatements.mjs";
import { linkPendingEmails } from "./store";

const LEGACY_EMAILS_TABLE = `
  CREATE TABLE applications (
    id serial PRIMARY KEY,
    gmail_message_id text NOT NULL UNIQUE,
    company text NOT NULL,
    role text,
    category text NOT NULL,
    subject text, snippet text, body text, body_html text, from_email text,
    received_at timestamptz NOT NULL,
    reminder_due_at timestamptz,
    classified_by text, classifier_evidence text,
    reminder_count integer NOT NULL DEFAULT 0,
    last_reminder_at timestamptz,
    reminder_sent boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;

describe("migrate-linking", () => {
  test("applies to a legacy database, keeps its rows, and the linker then works on it", async () => {
    const pg = new PGlite();
    await pg.exec(LEGACY_EMAILS_TABLE);
    await pg.exec(`INSERT INTO applications (gmail_message_id, company, role, category, received_at)
                   VALUES ('old1', 'Cotiviti', 'Data Scientist I', 'Applied', '2026-09-20T12:00:00Z')`);

    for (const statement of STATEMENTS as string[]) await pg.exec(statement);

    const db = drizzle(pg, { schema });
    const kept = await db.select().from(applications);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ company: "Cotiviti", linkState: null, threadId: null });

    const summary = await linkPendingEmails(db as never, { ownerEmail: null });
    expect(summary.created).toBe(1);
    expect(await db.select().from(jobApplications)).toHaveLength(1);
  });

  test("is idempotent: running it twice changes nothing and does not error", async () => {
    const pg = new PGlite();
    await pg.exec(LEGACY_EMAILS_TABLE);
    for (const statement of STATEMENTS as string[]) await pg.exec(statement);
    for (const statement of STATEMENTS as string[]) await pg.exec(statement);
    const { rows } = await pg.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='applications' AND column_name='thread_id'`);
    expect((rows[0] as { n: number }).n).toBe(1);
  });
});
