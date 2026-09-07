// One HTTP call to one OpenRouter model. No retries, no fallback, no pacing —
// those are complete.ts's job, and keeping them out of here is what makes this
// testable with a single fetch stub.

import { LlmError, classifyHttpStatus } from "./errors";
import type { ModelConfig } from "./models";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Requests that hang are worse than requests that fail: the sync run has a 45s
// wall-clock budget for the whole batch, so one stuck socket can eat all of it.
const REQUEST_TIMEOUT_MS = 20_000;

export type ChatRequest = {
  system: string;
  user: string;
  maxTokens: number;
  // Ask the provider to constrain output to a JSON object. Both models in the chain
  // support it; it does not replace defensive parsing, it just makes it rarer.
  json?: boolean;
};

export type ChatResponse = {
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
};

export function requireApiKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    // Fatal on purpose: with no key every model in the chain fails identically, so
    // there is nothing for the fallback logic to do.
    throw new LlmError("OPENROUTER_API_KEY not set", { kind: "fatal", model: "-" });
  }
  return key;
}

export async function chat(model: ModelConfig, request: ChatRequest): Promise<ChatResponse> {
  const apiKey = requireApiKey();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        // OpenRouter attributes usage in the dashboard by these. Neither is required.
        "HTTP-Referer": "https://github.com/harshrc1357/job-tracker",
        "X-Title": "job-tracker",
      },
      body: JSON.stringify({
        model: model.id,
        temperature: 0,
        max_tokens: request.maxTokens,
        ...(request.json ? { response_format: { type: "json_object" } } : {}),
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
      }),
    });
  } catch (err) {
    // Network failure or our own timeout. Both are transient by nature, so this is
    // retryable rather than fatal.
    const reason = err instanceof Error && err.name === "AbortError" ? "timed out" : describe(err);
    throw new LlmError(`request failed: ${reason}`, {
      kind: "retryable",
      model: model.id,
      cause: err,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const body = await safeText(res);
    throw new LlmError(`HTTP ${res.status} ${truncate(body, 300)}`, {
      kind: classifyHttpStatus(res.status),
      model: model.id,
      status: res.status,
      retryAfterSeconds: parseRetryAfter(res.headers.get("retry-after")),
    });
  }

  const data = await res.json().catch((err) => {
    throw new LlmError(`response was not JSON: ${describe(err)}`, {
      kind: "unusable",
      model: model.id,
      cause: err,
    });
  });

  // OpenRouter can return HTTP 200 with an error object inside when an upstream
  // provider fails mid-stream. Treating that as a successful empty answer is how a
  // dead model 404s silently for a week, so it is surfaced as a real failure.
  const embedded = data?.error;
  if (embedded) {
    const status = typeof embedded.code === "number" ? embedded.code : undefined;
    throw new LlmError(`provider error: ${truncate(String(embedded.message ?? embedded), 300)}`, {
      kind: status ? classifyHttpStatus(status) : "retryable",
      model: model.id,
      status,
    });
  }

  const content: unknown = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new LlmError("empty completion", { kind: "unusable", model: model.id });
  }

  return {
    content: content.trim(),
    model: typeof data?.model === "string" ? data.model : model.id,
    promptTokens: numberOr(data?.usage?.prompt_tokens, 0),
    completionTokens: numberOr(data?.usage?.completion_tokens, 0),
  };
}

// "Retry-After: 30" (seconds) or an HTTP date. Anything unparseable means we fall
// back to our own backoff rather than guessing.
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const at = Date.parse(header);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "(no body)";
  }
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
