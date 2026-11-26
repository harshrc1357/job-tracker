import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { chat } from "./openrouter";
import { LlmError } from "./errors";
import { PRIMARY_MODEL } from "./models";

beforeEach(() => {
  vi.useFakeTimers();
  process.env.OPENROUTER_API_KEY = "test-key";
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.OPENROUTER_API_KEY;
});

test("gives up with a retryable error when the provider sends headers and then stalls the body", async () => {
  // Arrange: a 200 whose body never arrives, but errors when the request is aborted, the
  // way a real fetch body does.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = new ReadableStream({
        start(stream) {
          init.signal?.addEventListener("abort", () => stream.error(new DOMException("aborted", "AbortError")));
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    })
  );

  // Act
  const pending = chat(PRIMARY_MODEL, { system: "s", user: "u", maxTokens: 10 }).catch((err) => err);
  await vi.advanceTimersByTimeAsync(20_000);
  const err = await pending;

  // Assert
  expect(err).toBeInstanceOf(LlmError);
  expect(err.kind).toBe("retryable");
  expect(err.message).toMatch(/timed out/);
});

test("asks OpenRouter to route only to providers that do not collect or train on the email", async () => {
  // Arrange
  const fetchStub = vi.fn(async (_url: string, _init: RequestInit) =>
    Response.json({ choices: [{ message: { content: "{}" } }], usage: {} })
  );
  vi.stubGlobal("fetch", fetchStub);

  // Act
  await chat(PRIMARY_MODEL, { system: "s", user: "u", maxTokens: 10 });

  // Assert
  const body = JSON.parse(fetchStub.mock.calls[0][1].body as string);
  expect(body.provider).toEqual({ data_collection: "deny" });
});
