// Three failure kinds, because the caller does three different things with them.
//
// - retryable: throttling or a provider hiccup. Wait, then try again or fall back to
//   the other model. Must NEVER be banked as a classification decision — doing that
//   permanently discards real mail over a temporary problem.
// - fatal: our request or our config is wrong (bad key, bad model slug, malformed
//   body). Retrying and falling back both produce the identical failure, so stop.
// - unusable: the call succeeded but the answer cannot be used (empty content,
//   unparseable JSON). Worth one retry on the other model, never worth banking.

export type LlmFailureKind = "retryable" | "fatal" | "unusable";

export class LlmError extends Error {
  readonly kind: LlmFailureKind;
  readonly model: string;
  readonly status?: number;
  // Seconds the provider asked us to wait, when it said so. Undefined otherwise —
  // absence means "use our own backoff", not "retry immediately".
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    options: {
      kind: LlmFailureKind;
      model: string;
      status?: number;
      retryAfterSeconds?: number;
      cause?: unknown;
    }
  ) {
    super(message, { cause: options.cause });
    this.name = "LlmError";
    this.kind = options.kind;
    this.model = options.model;
    this.status = options.status;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

// Every model in the chain failed. Carries the individual failures so the sync
// alert can say *why* rather than just "classification failed".
export class LlmUnavailableError extends Error {
  readonly failures: readonly LlmError[];

  constructor(failures: readonly LlmError[]) {
    const detail = failures.map((f) => `${f.model}: ${f.message}`).join(" | ");
    super(`all classifier models failed — ${detail}`);
    this.name = "LlmUnavailableError";
    this.failures = failures;
  }

  // True when the run died on throttling rather than on a broken request. sync's
  // alert path reports these differently: a throttle self-heals next tick, a fatal
  // config error will not.
  get isThrottled(): boolean {
    return this.failures.some((f) => f.kind === "retryable" && f.status === 429);
  }
}

// 429 is throttling. 408/409/5xx are transient server-side. Everything else in the
// 4xx range is our fault and will fail identically forever.
export function classifyHttpStatus(status: number): LlmFailureKind {
  if (status === 429 || status === 408 || status === 409) return "retryable";
  if (status >= 500) return "retryable";
  return "fatal";
}
