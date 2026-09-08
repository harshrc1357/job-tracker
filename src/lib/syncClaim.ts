// Decides whether this request is allowed to actually run a sync.
//
// One conditional UPDATE does two jobs that would otherwise need separate
// machinery:
//
//   1. Rate limit. /api/sync no longer requires a secret to trigger (see the route
//      for why), so it has to be safe for a stranger to hammer. Whoever calls it, a
//      sync happens at most once per MIN_SYNC_INTERVAL_MS. A thousand requests a
//      second cost exactly what your own cron costs.
//
//   2. Mutual exclusion. Two overlapping runs both classifying the same messages was
//      a known piece of waste. The same statement closes it: the row is claimed
//      before any work starts, so the second caller loses and returns immediately.
//
// It is one statement on purpose. A read-then-write would let two callers both see a
// stale timestamp and both proceed, which is the exact bug this is here to prevent.

import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { syncState } from "@/db/schema";
import { MIN_SYNC_INTERVAL_MS } from "@/lib/constants";

export type ClaimOutcome =
  // Go ahead. This caller now owns the interval.
  | { claimed: true }
  // Someone synced (or is syncing) too recently. Not an error — the correct,
  // expected answer for most calls once an external pinger is pointed at this.
  | { claimed: false; reason: "too-soon" }
  // The claim itself failed. Reported rather than swallowed, but the caller decides
  // whether to proceed: refusing to sync because a bookkeeping table is unreachable
  // would turn a small problem into a stopped pipeline.
  | { claimed: false; reason: "error"; message: string };

export async function claimSyncSlot(now: Date = new Date()): Promise<ClaimOutcome> {
  const cutoff = new Date(now.getTime() - MIN_SYNC_INTERVAL_MS);

  try {
    // Seed the single row on first ever run. onConflictDoNothing keeps this safe
    // when two cold callers arrive together.
    await db
      .insert(syncState)
      .values({ id: 1, lastSyncedAt: new Date(0), messagesChecked: 0 })
      .onConflictDoNothing();

    const claimed = await db
      .update(syncState)
      .set({ lastSyncedAt: now })
      .where(sql`${syncState.id} = 1 AND ${syncState.lastSyncedAt} < ${cutoff}`)
      .returning({ id: syncState.id });

    return claimed.length > 0 ? { claimed: true } : { claimed: false, reason: "too-soon" };
  } catch (err) {
    return {
      claimed: false,
      reason: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
