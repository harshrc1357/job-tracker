// Token bucket, shared by every concurrent classification worker in one run.
//
// OpenRouter imposes no per-request cap on paid model variants (only ":free" ones
// are capped at 20/min), so nothing external stops SYNC_CONCURRENCY workers firing
// at once. What does bite is the *upstream* provider throttling, and Cloudflare's
// DDoS protection in front of OpenRouter. Both show up as a 429 that costs a retry
// and, worse, leaves real job mail unclassified for another cycle. Pacing ourselves
// is strictly cheaper than being paced.
//
// Deliberately not persisted: a bucket is a statement about the last sixty seconds,
// and a serverless invocation that outlives sixty seconds is already over its time
// budget. The per-DAY ceiling is the thing that needs durable storage, and that
// lives in dailyUsage.ts.

const MS_PER_MINUTE = 60_000;

export type RateLimiterOptions = {
  requestsPerMinute: number;
  // How many requests may go out back-to-back before pacing kicks in. Defaults to
  // one second's worth, minimum 1, which keeps a small batch snappy without letting
  // a 500-message backlog open 500 sockets at once.
  burst?: number;
};

export type RateLimiter = {
  acquire: () => Promise<void>;
  // Exposed for the sync result payload — "we were throttling ourselves" is a
  // different diagnosis from "the provider throttled us", and the alert should
  // be able to tell them apart.
  stats: () => { granted: number; totalWaitMs: number };
};

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { requestsPerMinute } = options;
  if (!Number.isFinite(requestsPerMinute) || requestsPerMinute <= 0) {
    throw new Error(`requestsPerMinute must be a positive number, got ${requestsPerMinute}`);
  }

  const refillIntervalMs = MS_PER_MINUTE / requestsPerMinute;
  const capacity = Math.max(1, options.burst ?? Math.ceil(requestsPerMinute / 60));

  let tokens = capacity;
  let lastRefillAt = Date.now();
  let granted = 0;
  let totalWaitMs = 0;

  // Serialises the waiters. Without it, N callers all read the same token count in
  // the same tick and all decide there is room, which is exactly the burst the
  // limiter exists to prevent.
  let queueTail: Promise<void> = Promise.resolve();

  const refill = () => {
    const now = Date.now();
    const elapsed = now - lastRefillAt;
    if (elapsed <= 0) return;
    const earned = elapsed / refillIntervalMs;
    if (earned <= 0) return;
    tokens = Math.min(capacity, tokens + earned);
    lastRefillAt = now;
  };

  const takeOneToken = async (): Promise<void> => {
    refill();
    if (tokens < 1) {
      const waitMs = Math.ceil((1 - tokens) * refillIntervalMs);
      totalWaitMs += waitMs;
      await sleep(waitMs);
      refill();
    }
    tokens = Math.max(0, tokens - 1);
    granted++;
  };

  return {
    acquire: () => {
      const turn = queueTail.then(takeOneToken);
      // Swallow on the chain only. The returned promise still rejects for the
      // caller; this just stops one failure poisoning every queued waiter behind it.
      queueTail = turn.then(
        () => undefined,
        () => undefined
      );
      return turn;
    },
    stats: () => ({ granted, totalWaitMs }),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
