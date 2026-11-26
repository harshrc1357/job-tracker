import { isNull, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { applications, reviewItems } from "@/db/schema";
import { pipelineApps, type AppRow } from "@/lib/link/views";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PgDatabase<any, any>;

export type ShellCounts = { pipeline: number; applications: number; inbox: number; review: number };

// Called by each page AFTER its own queries, so queries on the one shared connection
// stay strictly sequential. Takes the application rows the page already loaded.
export async function loadShellCounts(db: Db, rows: readonly AppRow[]): Promise<ShellCounts | null> {
  try {
    const [emails] = await db.select({ n: sql<number>`count(*)::int` }).from(applications);
    const [review] = await db.select({ n: sql<number>`count(*)::int` }).from(reviewItems).where(isNull(reviewItems.resolvedAt));
    return { pipeline: pipelineApps(rows, "active").length, applications: rows.length, inbox: emails?.n ?? 0, review: review?.n ?? 0 };
  } catch {
    return null;
  }
}
