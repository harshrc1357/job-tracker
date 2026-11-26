// Process-wide handles the classifier draws on: one token bucket per model, and one
// daily quota.
//
// Module state rather than threaded parameters, because the alternative is passing a
// limiter and a quota through classifyEmail into every call site purely so they can
// be handed to complete(). A sync run is one process doing one job; the pacing has to
// be shared across its concurrent workers or it is not pacing at all.
//
// The quota starts empty and unbudgeted-from-storage. sync/route.ts calls
// setQuota() with the counts it read from the database before it classifies anything.

import { createRateLimiter, type RateLimiter } from "./rateLimiter";
import { createQuota, type Quota } from "./quota";
import { MODEL_CHAIN, type ModelConfig } from "./models";

const limiters = new Map<string, RateLimiter>();

// A warm lambda reuses this between runs. That is fine and slightly desirable: the
// bucket carries a little of the previous run's pressure, which is true.
export function getLimiter(model: ModelConfig): RateLimiter {
  const existing = limiters.get(model.id);
  if (existing) return existing;
  const limiter = createRateLimiter({ requestsPerMinute: model.requestsPerMinute });
  limiters.set(model.id, limiter);
  return limiter;
}

let quota: Quota = createQuota();

export function setQuota(initialCounts: Record<string, number>): Quota {
  quota = createQuota(initialCounts);
  return quota;
}

export function getQuota(): Quota {
  return quota;
}

export function limiterStats(): Record<string, { granted: number; totalWaitMs: number }> {
  const stats: Record<string, { granted: number; totalWaitMs: number }> = {};
  for (const model of MODEL_CHAIN) {
    const limiter = limiters.get(model.id);
    if (limiter) stats[model.id] = limiter.stats();
  }
  return stats;
}

// Tests only. Without it, one test's exhausted bucket paces the next one.
export function resetRuntimeForTests(): void {
  limiters.clear();
  quota = createQuota();
}
