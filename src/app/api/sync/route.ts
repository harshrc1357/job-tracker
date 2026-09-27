import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { getGmailClient } from "@/lib/gmail";
import { db } from "@/db/client";
import { applications, ignoredMessages } from "@/db/schema";
import { loadDailyUsage, ownerDayKey, recordDailyUsage } from "@/lib/llm/dailyUsage";
import { getQuota, setQuota } from "@/lib/llm/runtime";
import { escapeMarkdownV2, sendTelegramMessage, trySendTelegramMessage } from "@/lib/telegram";
import { REMINDER_CATEGORIES } from "@/lib/categories";
import {
  LLM_CALLS_PER_RUN,
  MAX_REMINDERS_PER_APPLICATION,
  MIN_SYNC_INTERVAL_MS,
  SYNC_CONCURRENCY,
  SYNC_TIME_BUDGET_MS,
} from "@/lib/constants";
import { claimSyncSlot } from "@/lib/syncClaim";
import { decideReminder } from "@/lib/reminderPolicy";
import {
  buildJobQuery,
  describe,
  processMessage,
  type MessageOutcome,
} from "@/lib/sync/message";
import { lookbackDays } from "@/lib/sync/lookback";

export const runtime = "nodejs";
export const maxDuration = 60;


const MAX_LISTED_MESSAGES = 500;

// How many individual errors get quoted in the Telegram alert before it truncates.
const MAX_ALERT_ERRORS = 5;

type SyncResult = {
  listed: number;
  alreadyStored: number;
  processed: number;
  inserted: number;
  ignored: number;
  llmCalls: number;
  // Actual HTTP calls per model id, including retries. llmCalls above counts
  // *intended* calls (one per message needing classification); this counts what the
  // provider actually saw, which is the number that maps to the bill.
  llmCallsByModel: Record<string, number>;
  // How many messages had to be answered by the fallback model. A steady nonzero
  // here means the primary is degraded, not that the fallback is doing its job well.
  fallbackAnswers: number;
  remindersSent: number;
  remaining: number;
  ranOutOfTime: boolean;
  hitLlmBudget: boolean;
  wasRateLimited: boolean;
  errors: string[];
};

// What one message turned into. Kept as data rather than as a direct db.insert so the
// fetch/classify work can run concurrently while the writes stay ordered and cheap.

// Triggering a sync no longer requires a secret, and that is a deliberate trade,
// not a loosening.
//
// The secret used to be the only thing standing between a stranger and (a) burning
// the LLM budget and (b) reading email subjects out of the response. But it had to
// live wherever the trigger lived — GitHub's servers today, a third-party cron
// service tomorrow — so every reliable trigger meant handing the credential to one
// more party. GitHub's scheduler delivers roughly 2.5% of a */5 cron, so a better
// trigger was needed, which meant another copy of the secret.
//
// Instead both risks are removed at the source:
//
//   spend  -> claimSyncSlot caps real runs at one per MIN_SYNC_INTERVAL_MS, on top
//             of the existing per-run and per-day LLM caps. Being hammered costs
//             exactly what the ordinary cron costs.
//   data   -> an unauthenticated caller gets {ok:true} and nothing else. The counts
//             and the errors array (which quotes subjects and sender names) are only
//             returned to a caller holding CRON_SECRET.
//
// The endpoint takes no caller-controlled input, so it cannot be steered: it always
// does the same one job against the owner's own mailbox. And the dashboard, which is
// where the actual email content lives, is untouched behind Google sign-in.
//
// CRON_SECRET therefore stops being an access control and becomes a debug switch.
function isTrustedCaller(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;

  // Header first: query strings end up in Vercel's logs, the caller's logs, and any
  // proxy in between. The query param stays supported so the existing GitHub Actions
  // workflow keeps working unchanged.
  const header = req.headers.get("authorization");
  if (header === `Bearer ${expected}`) return true;

  return req.nextUrl.searchParams.get("secret") === expected;
}

export async function GET(req: NextRequest) {
  const trusted = isTrustedCaller(req);

  // Trusted-only, and deliberately so. It is not a security boundary in the usual sense
  // — the worst a stranger could do with it is make a sync quieter — but a public
  // switch that silences alerts is one an attacker would reach for first, and there is
  // no reason for it to exist outside a hand-run migration.
  const isBackfill = trusted && req.nextUrl.searchParams.get("backfill") === "1";

  // Everything a caller without the secret is ever told. No counts, no error strings,
  // and identical whether the sync ran, was throttled, or found nothing — so it
  // cannot be used to probe for activity either.
  const quiet = () => NextResponse.json({ ok: true });

  const startedAt = Date.now();
  const hasTimeLeft = () => Date.now() - startedAt < SYNC_TIME_BUDGET_MS;

  const result: SyncResult = {
    listed: 0,
    alreadyStored: 0,
    processed: 0,
    inserted: 0,
    ignored: 0,
    llmCalls: 0,
    llmCallsByModel: {},
    fallbackAnswers: 0,
    remindersSent: 0,
    remaining: 0,
    ranOutOfTime: false,
    hitLlmBudget: false,
    wasRateLimited: false,
    errors: [],
  };

  // Shared across the whole run. Handed to processMessage so concurrent workers draw
  // from one pool rather than each getting their own allowance.
  const llmBudget = { remaining: LLM_CALLS_PER_RUN, used: 0 };

  const day = ownerDayKey();

  // Reads the live quota through getQuota() rather than closing over the object
  // setQuota() returns, so this is safe to define before the quota has been seeded —
  // which matters because seeding it is now a database call inside the try below, and
  // the catch has to be able to flush whatever was spent before it failed. An unseeded
  // quota simply has no deltas.
  const flushUsage = async () => {
    const quota = getQuota();
    const deltas = quota.deltas();
    quota.clearDeltas();
    result.llmCallsByModel = mergeCounts(result.llmCallsByModel, deltas);
    try {
      await recordDailyUsage(day, deltas);
    } catch (err) {
      // Losing the write is bad (the day's cap drifts high) but killing the run over
      // it is worse — the classifications themselves are already banked.
      result.errors.push(`usage write: ${describe(err)}`);
    }
  };

  try {
    // Both of these talk to the database, and both used to run BEFORE this try. A dead
    // database therefore threw past every guard below: the route returned a bare 500
    // with no body, the "untrusted callers only ever see a quiet 200" rule was
    // bypassed, and no Telegram alert fired. cron-job.org saw four of those in a row
    // and disabled the job, which is how a Neon quota outage turned into a silently
    // stopped sync. Inside the try, the same failure is a quiet 200 plus an alert.
    const claim = await claimSyncSlot();
    if (!claim.claimed && claim.reason === "too-soon") {
      return trusted
        ? NextResponse.json({ ok: true, skipped: "too-soon", minIntervalMs: MIN_SYNC_INTERVAL_MS })
        : quiet();
    }
    if (!claim.claimed) {
      // The bookkeeping row is unreachable. Proceeding unthrottled is the lesser evil:
      // the LLM day/run caps still bound the spend, and refusing to sync because a
      // timestamp could not be written would stop real mail over a trivial fault.
      console.error("[sync] claim failed, proceeding unthrottled", claim.message);
    }

    // The per-DAY ceiling, seeded from the database. Without this a serverless run
    // starts from zero on every invocation, which is the same as having no ceiling.
    // Deltas are flushed after every batch below, not just at the end, so a run that
    // dies halfway does not un-spend what it already spent.
    setQuota(await loadDailyUsage(day));

    const gmail = await getGmailClient();
    const list = await gmail.users.messages.list({
      userId: "me",
      q: buildJobQuery(lookbackDays()),
      maxResults: MAX_LISTED_MESSAGES,
    });
    const messages = list.data.messages ?? [];
    result.listed = messages.length;

    // One query for every id we already hold, instead of a SELECT per message. At a
    // 14-day window that was 100+ sequential database round trips per run before any
    // real work started, and it is most of why every run was hitting the 60s wall.
    //
    // Sequential, NOT Promise.all. Supabase's transaction-mode pooler assigns a
    // backend per transaction, and postgres-js with max:1 pipelines two concurrent
    // queries down a single connection. The pooler cannot split that pipeline, so it
    // stalls indefinitely instead of erroring — one query answers in ~300ms, two in a
    // Promise.all never return. Under a 60s serverless ceiling that surfaced as
    // FUNCTION_INVOCATION_TIMEOUT with no error and nothing written, which is exactly
    // what the first backfill attempt did. Two round trips cost ~600ms; there was
    // never a reason to parallelise them.
    const stored = await db
      .select({ gmailMessageId: applications.gmailMessageId })
      .from(applications);
    const ignored = await db
      .select({ gmailMessageId: ignoredMessages.gmailMessageId })
      .from(ignoredMessages);
    // Ignored ids count as "seen" exactly like stored ones. That is the whole point:
    // a message judged not-job-related must never cost a second LLM call.
    const seenIds = new Set([
      ...stored.map((row) => row.gmailMessageId),
      ...ignored.map((row) => row.gmailMessageId),
    ]);

    const fresh = messages.flatMap((message) =>
      message.id && !seenIds.has(message.id) ? [message.id] : []
    );
    result.alreadyStored = messages.length - fresh.length;

    // Fetch and classify in small concurrent batches, checking the clock between
    // them. Anything left when the budget runs out simply stays unrecorded, so the
    // next tick picks it up — partial progress that reports itself beats a 504 that
    // reports nothing.
    for (let offset = 0; offset < fresh.length; offset += SYNC_CONCURRENCY) {
      if (!hasTimeLeft()) {
        result.ranOutOfTime = true;
        break;
      }

      const batch = fresh.slice(offset, offset + SYNC_CONCURRENCY);
      const outcomes = await Promise.all(batch.map((id) => processMessage(gmail, id, llmBudget)));
      result.processed += batch.length;
      result.llmCalls = llmBudget.used;
      await flushUsage();

      for (const outcome of outcomes) {
        if (outcome.status === "error") result.errors.push(outcome.message);
        if (outcome.status === "store" && outcome.usedFallback) result.fallbackAnswers++;
        if (outcome.status === "rateLimited" && !result.wasRateLimited) {
          // Report the throttle once, not once per message. The remaining messages
          // are untouched and get picked up whenever the quota comes back.
          result.wasRateLimited = true;
          result.errors.push(outcome.message);
        }
      }

      // Record the skips before anything else. If the run dies after this point the
      // work is still banked, which is what stops the treadmill restarting.
      const toIgnore = outcomes.flatMap((outcome) =>
        outcome.status === "ignore" ? [{ gmailMessageId: outcome.messageId }] : []
      );
      if (toIgnore.length > 0) {
        await db.insert(ignoredMessages).values(toIgnore).onConflictDoNothing();
        result.ignored += toIgnore.length;
      }

      // Budget spent mid-batch: everything after this needs an LLM call we cannot
      // make, so stop cleanly rather than logging one 429 per remaining message.
      if (llmBudget.remaining <= 0 && outcomes.some((o) => o.status === "defer")) {
        result.hitLlmBudget = true;
      }

      const toStore = outcomes.flatMap((outcome) =>
        outcome.status === "store" ? [outcome] : []
      );

      // Store whatever this batch already produced, then stop. Everything past here
      // needs a call the provider is refusing, so continuing only manufactures
      // identical errors.
      if ((result.hitLlmBudget || result.wasRateLimited) && toStore.length === 0) break;
      if (toStore.length === 0) continue;

      // onConflictDoNothing plus `returning` makes this safe against two overlapping
      // runs: whichever loses the race inserts nothing and gets nothing back, so only
      // the winner sends the Telegram notification. No duplicate pings.
      const insertedRows = await db
        .insert(applications)
        .values(toStore.map((outcome) => outcome.values))
        .onConflictDoNothing({ target: applications.gmailMessageId })
        .returning({ gmailMessageId: applications.gmailMessageId });

      const insertedIds = new Set(insertedRows.map((row) => row.gmailMessageId));
      result.inserted += insertedRows.length;

      for (const outcome of toStore) {
        // A backfill re-imports mail that is days or weeks old into an empty database.
        // Every Interview/Assessment/Offer row in it looks brand new to the code above,
        // so without this the rebuild pushes dozens of stale interview invites at him
        // in one burst, and a genuinely new one is indistinguishable in the flood.
        if (isBackfill) continue;
        if (!outcome.notify) continue;
        if (!insertedIds.has(outcome.values.gmailMessageId)) continue;
        try {
          await sendTelegramMessage(formatArrivalMessage(outcome.values));
        } catch (err) {
          result.errors.push(`notify ${outcome.values.gmailMessageId}: ${describe(err)}`);
        }
      }
    }

    // Remaining means "not yet banked", not "not yet looked at". A message is only
    // done when it is either stored or recorded as ignored — anything else (errored,
    // deferred, cut off by the clock) comes back on the next run.
    result.remaining = Math.max(fresh.length - result.inserted - result.ignored, 0);

    await runReminderPass(result, hasTimeLeft);
  } catch (err) {
    await flushUsage();
    result.errors.push(describe(err));
    console.error("[sync] failed", err);
    await alertOnProblems(result, describe(err));
    // 200 and silence for an untrusted caller even on failure. A 500 with a stack in
    // it is exactly the kind of detail this endpoint should not hand to strangers,
    // and the failure still reaches the owner over Telegram via alertOnProblems.
    if (!trusted) return quiet();
    return NextResponse.json({ ok: false, ...result }, { status: 500 });
  }

  await alertOnProblems(result, null);
  return trusted ? NextResponse.json({ ok: true, ...result }) : quiet();
}

// Fetches one message and works out what, if anything, to store for it. Returns
async function runReminderPass(result: SyncResult, hasTimeLeft: () => boolean) {
  const now = new Date();

  const pending = await db
    .select()
    .from(applications)
    .where(
      and(
        isNotNull(applications.reminderDueAt),
        eq(applications.reminderSent, false),
        inArray(applications.category, REMINDER_CATEGORIES)
      )
    );

  for (const app of pending) {
    if (!hasTimeLeft()) {
      result.ranOutOfTime = true;
      return;
    }

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
      await sendTelegramMessage(formatReminderMessage(app, decision.nextCount));
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

// A red run in a CI dashboard nobody opens is not a notification. Sync problems have
// to reach the same place the reminders do, or the next outage goes unnoticed for
// days again — which is exactly how this one lasted from Sep 4 to Sep 6.
async function alertOnProblems(result: SyncResult, fatalError: string | null) {
  // A budget stop on its own is normal backlog draining, not a problem worth a ping.
  // It only gets reported when something else already made this alert fire.
  if (!fatalError && result.errors.length === 0 && !result.ranOutOfTime) return;

  // Only the heading is markup. Everything else is escaped body text, because it is
  // all attacker-adjacent: error strings carry subjects, sender names and API
  // responses, any of which can contain a stray asterisk or underscore.
  const lines = ["⚠️ *Job tracker sync problem*"];
  if (fatalError) lines.push(escapeMarkdownV2(`Run failed: ${fatalError}`));
  if (result.ranOutOfTime) {
    lines.push(
      escapeMarkdownV2(
        `Ran out of time with ${result.remaining} message(s) left. They retry next run.`
      )
    );
  }
  if (result.hitLlmBudget) {
    lines.push(
      escapeMarkdownV2(
        `Hit the ${LLM_CALLS_PER_RUN}-call LLM budget with ${result.remaining} message(s) left. They retry next run.`
      )
    );
  }
  if (result.wasRateLimited) {
    lines.push(
      escapeMarkdownV2(
        `The classifier is being rate limited. Stopped early with ${result.remaining} message(s) left; they retry once quota returns.`
      )
    );
  }
  if (result.errors.length > 0) {
    lines.push(escapeMarkdownV2(`${result.errors.length} error(s):`));
    // Cap the detail — a broken Groq key produces one error per message and Telegram
    // rejects anything over 4096 characters.
    lines.push(...result.errors.slice(0, MAX_ALERT_ERRORS).map((e) => escapeMarkdownV2(`• ${e}`)));
  }

  await trySendTelegramMessage(lines.join("\n"));
}

function formatArrivalMessage(values: typeof applications.$inferInsert): string {
  const category = escapeMarkdownV2(String(values.category));
  const company = escapeMarkdownV2(values.company);
  const subject = escapeMarkdownV2(values.subject ?? "");
  const snippet = escapeMarkdownV2((values.snippet ?? "").slice(0, 200));
  return `*${category}* — ${company}\n${subject}\n\n_${snippet}_`;
}

function formatReminderMessage(
  app: typeof applications.$inferSelect,
  nextCount: number
): string {
  const category = escapeMarkdownV2(app.category);
  const company = escapeMarkdownV2(app.company);
  const subject = escapeMarkdownV2(app.subject ?? "");
  const due = escapeMarkdownV2(app.reminderDueAt?.toLocaleString() ?? "");
  const counter = escapeMarkdownV2(`Reminder ${nextCount} of ${MAX_REMINDERS_PER_APPLICATION}`);
  return `⏰ *${category} coming up* — ${company}\n${subject}\nDue: ${due}\n_${counter}_`;
}

function mergeCounts(
  into: Record<string, number>,
  deltas: Record<string, number>
): Record<string, number> {
  const merged = { ...into };
  for (const [key, value] of Object.entries(deltas)) {
    merged[key] = (merged[key] ?? 0) + value;
  }
  return merged;
}
