// Durable half of the daily quota. quota.ts counts calls in memory during a run;
// this reads yesterday's-and-today's truth out of the database and writes the run's
// deltas back.
//
// The day key is the owner's local date, not UTC. A cron running at 8pm Central would
// otherwise roll the counter over mid-evening and hand itself a second full day's
// budget, which is exactly the bug a daily cap exists to prevent.

import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { llmUsage } from "@/db/schema";
import { OWNER_TIME_ZONE } from "@/lib/constants";

// en-CA formats as YYYY-MM-DD, which sorts and compares as a plain string.
const DAY_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: OWNER_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function ownerDayKey(now: Date = new Date()): string {
  return DAY_FORMATTER.format(now);
}

export async function loadDailyUsage(day: string): Promise<Record<string, number>> {
  const rows = await db
    .select({ model: llmUsage.model, calls: llmUsage.calls })
    .from(llmUsage)
    .where(sql`${llmUsage.day} = ${day}`);

  return Object.fromEntries(rows.map((row) => [row.model, row.calls]));
}

// Upsert-with-increment rather than write-the-total, so two overlapping runs both
// count. Losing a count is worse than an extra round trip: it silently doubles the
// day's spend.
export async function recordDailyUsage(day: string, deltas: Record<string, number>): Promise<void> {
  const values = Object.entries(deltas)
    .filter(([, calls]) => calls > 0)
    .map(([model, calls]) => ({ day, model, calls }));

  if (values.length === 0) return;

  await db
    .insert(llmUsage)
    .values(values)
    .onConflictDoUpdate({
      target: [llmUsage.day, llmUsage.model],
      set: { calls: sql`${llmUsage.calls} + excluded.calls`, updatedAt: new Date() },
    });
}
