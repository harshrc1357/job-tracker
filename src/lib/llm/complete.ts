// The one function the rest of the app calls to get text out of a model.
//
// Everything that makes an LLM call survivable lives here and nowhere else:
//   pacing   -> token bucket per model, shared across concurrent workers
//   ceiling  -> per-model daily quota, seeded from the database
//   retry    -> bounded, only on genuinely transient failures, honouring Retry-After
//   fallback -> next model in the chain when this one is throttled, broken or spent
//
// It never returns a degraded answer. If every model fails it throws
// LlmUnavailableError, and the caller leaves the message unrecorded so the next run
// retries it. Guessing a category from a failed call is how real interview invites
// get filed as "not job related" and vanish.

import { chat, type ChatRequest, type ChatResponse } from "./openrouter";
import { LlmError, LlmUnavailableError } from "./errors";
import { MODEL_CHAIN, type ModelConfig } from "./models";
import { getLimiter, getQuota } from "./runtime";

// Two tries per model, not more. A third attempt against a provider that has failed
// twice inside a 45-second run is spending the run's remaining budget on hope.
const MAX_ATTEMPTS_PER_MODEL = 2;

// Backoff between attempts on the same model, when the provider gave no Retry-After.
const BASE_BACKOFF_MS = 750;

// A provider asking us to wait longer than this is telling us to come back next run,
// not to sleep through the sync's entire time budget.
const MAX_HONOURED_RETRY_AFTER_MS = 5_000;

export type CompletionOutcome = ChatResponse & {
  // How many HTTP calls it actually took, across all models. 1 in the happy path.
  attempts: number;
  // True when the answer came from something other than the primary model.
  usedFallback: boolean;
};

export async function complete(request: ChatRequest): Promise<CompletionOutcome> {
  const quota = getQuota();
  const failures: LlmError[] = [];
  let attempts = 0;

  for (const model of MODEL_CHAIN) {
    if (!quota.hasBudget(model)) {
      failures.push(
        new LlmError(`daily budget of ${model.requestsPerDay} calls is spent`, {
          kind: "retryable",
          model: model.id,
        })
      );
      continue;
    }

    const outcome = await tryModel(model, request, failures, () => attempts++);
    if (outcome) {
      return { ...outcome, attempts, usedFallback: model.id !== MODEL_CHAIN[0].id };
    }

    // A fatal failure on one model is almost always our request, not the provider —
    // same body, same key, same result on the next one. Stop rather than burn the
    // fallback's budget proving it.
    if (failures.at(-1)?.kind === "fatal") break;
  }

  throw new LlmUnavailableError(failures);
}

async function tryModel(
  model: ModelConfig,
  request: ChatRequest,
  failures: LlmError[],
  countAttempt: () => void
): Promise<ChatResponse | null> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt++) {
    // Consumed before the call, not after. An attempt that fails still cost the
    // provider a request, and a retry loop that only counts successes has no ceiling.
    if (!quotaConsume(model)) {
      failures.push(
        new LlmError(`daily budget of ${model.requestsPerDay} calls is spent`, {
          kind: "retryable",
          model: model.id,
        })
      );
      return null;
    }

    await getLimiter(model).acquire();
    countAttempt();

    try {
      return await chat(model, request);
    } catch (err) {
      const failure = toLlmError(err, model);
      failures.push(failure);

      if (failure.kind === "fatal") return null;
      if (attempt === MAX_ATTEMPTS_PER_MODEL) return null;

      await sleep(backoffMs(failure, attempt));
    }
  }

  return null;
}

function quotaConsume(model: ModelConfig): boolean {
  return getQuota().tryConsume(model);
}

function backoffMs(failure: LlmError, attempt: number): number {
  if (failure.retryAfterSeconds !== undefined) {
    return Math.min(failure.retryAfterSeconds * 1000, MAX_HONOURED_RETRY_AFTER_MS);
  }
  return BASE_BACKOFF_MS * attempt;
}

function toLlmError(err: unknown, model: ModelConfig): LlmError {
  if (err instanceof LlmError) return err;
  return new LlmError(describe(err), { kind: "retryable", model: model.id, cause: err });
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
