// Per-model daily call counters, in memory.
//
// The token bucket in rateLimiter.ts is a statement about the last sixty seconds and
// is correctly thrown away with the process. A per-DAY ceiling is not: a serverless
// run that starts with a fresh counter every invocation has no ceiling at all. So
// this is seeded from the database at the start of a run (see dailyUsage.ts) and its
// deltas are flushed back after every batch, not just at the end — a run that dies
// halfway must not un-spend what it already spent.

import { MODEL_CHAIN, type ModelConfig } from "./models";

export type Quota = {
  // True if the model has budget left. Does not consume.
  hasBudget: (model: ModelConfig) => boolean;
  // Consumes one call. Returns false (and consumes nothing) when the model is spent.
  tryConsume: (model: ModelConfig) => boolean;
  // Calls made since the last flush, per model id. Reading does not clear.
  deltas: () => Record<string, number>;
  // Called once the deltas are durably recorded, so they are not written twice.
  clearDeltas: () => void;
  used: (model: ModelConfig) => number;
};

export function createQuota(initialCounts: Record<string, number> = {}): Quota {
  const used = new Map<string, number>();
  const delta = new Map<string, number>();

  for (const model of MODEL_CHAIN) {
    used.set(model.id, Math.max(0, initialCounts[model.id] ?? 0));
  }

  const usedFor = (model: ModelConfig) => used.get(model.id) ?? 0;

  return {
    hasBudget: (model) => usedFor(model) < model.requestsPerDay,
    tryConsume: (model) => {
      if (usedFor(model) >= model.requestsPerDay) return false;
      used.set(model.id, usedFor(model) + 1);
      delta.set(model.id, (delta.get(model.id) ?? 0) + 1);
      return true;
    },
    deltas: () => Object.fromEntries(delta),
    clearDeltas: () => delta.clear(),
    used: usedFor,
  };
}
