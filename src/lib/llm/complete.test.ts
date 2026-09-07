import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { complete } from "./complete";
import { LlmUnavailableError } from "./errors";
import { FALLBACK_MODEL, PRIMARY_MODEL } from "./models";
import { getQuota, resetRuntimeForTests, setQuota } from "./runtime";

// Every response carries Retry-After: 0 so the backoff is real code running with a
// zero delay, rather than the tests sleeping through it.
const NO_WAIT = { "retry-after": "0" };

const ok = (content: string) =>
  new Response(
    JSON.stringify({
      model: PRIMARY_MODEL.id,
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );

const fail = (status: number, body = "nope") =>
  new Response(body, { status, headers: NO_WAIT });

const request = { system: "s", user: "u", maxTokens: 10 };

const modelOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body)).model;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetRuntimeForTests();
  process.env.OPENROUTER_API_KEY = "test-key";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("complete", () => {
  test("returns the primary model's answer without touching the fallback", () => {
    // Arrange
    fetchMock.mockResolvedValueOnce(ok("Assessment"));

    // Act + Assert
    return complete(request).then((result) => {
      expect(result.content).toBe("Assessment");
      expect(result.attempts).toBe(1);
      expect(result.usedFallback).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(modelOf(fetchMock.mock.calls[0])).toBe(PRIMARY_MODEL.id);
    });
  });

  test("retries the same model once on a 429, then moves to the fallback", async () => {
    // Arrange: two throttles is enough evidence that waiting inside a 45-second sync
    // run is not going to help.
    fetchMock
      .mockResolvedValueOnce(fail(429))
      .mockResolvedValueOnce(fail(429))
      .mockResolvedValueOnce(ok("Interview"));

    // Act
    const result = await complete(request);

    // Assert
    expect(result.content).toBe("Interview");
    expect(result.usedFallback).toBe(true);
    expect(result.attempts).toBe(3);
    expect(modelOf(fetchMock.mock.calls[2])).toBe(FALLBACK_MODEL.id);
  });

  test("stops on a fatal error instead of burning the fallback's budget on it", async () => {
    // Arrange: a 400 is our request, not the provider. The other model will reject
    // the identical body in the identical way.
    fetchMock.mockResolvedValue(fail(400, "malformed body"));

    // Act
    const error = await complete(request).catch((err) => err);

    // Assert
    expect(error).toBeInstanceOf(LlmUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((error as LlmUnavailableError).isThrottled).toBe(false);
  });

  test("skips a model that has spent its daily budget and uses the next one", async () => {
    // Arrange
    setQuota({ [PRIMARY_MODEL.id]: PRIMARY_MODEL.requestsPerDay });
    fetchMock.mockResolvedValueOnce(ok("Applied"));

    // Act
    const result = await complete(request);

    // Assert
    expect(result.usedFallback).toBe(true);
    expect(modelOf(fetchMock.mock.calls[0])).toBe(FALLBACK_MODEL.id);
  });

  test("throws, rather than returning a guess, when every model is exhausted", async () => {
    // Arrange: this is load-bearing. A degraded answer here gets banked as a
    // classification and the email is never reconsidered.
    setQuota({
      [PRIMARY_MODEL.id]: PRIMARY_MODEL.requestsPerDay,
      [FALLBACK_MODEL.id]: FALLBACK_MODEL.requestsPerDay,
    });

    // Act
    const error = await complete(request).catch((err) => err);

    // Assert
    expect(error).toBeInstanceOf(LlmUnavailableError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((error as Error).message).toContain("daily budget");
  });

  test("reports a throttled outage distinctly, so sync can say it self-heals", async () => {
    // Arrange
    fetchMock.mockResolvedValue(fail(429));

    // Act
    const error = await complete(request).catch((err) => err);

    // Assert
    expect(error).toBeInstanceOf(LlmUnavailableError);
    expect((error as LlmUnavailableError).isThrottled).toBe(true);
    // Two attempts on each of the two models.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  test("counts failed attempts against the daily budget", async () => {
    // Arrange: a retry loop that only counts successes has no ceiling. The provider
    // saw the request either way.
    fetchMock.mockResolvedValue(fail(500));

    // Act
    await complete(request).catch(() => undefined);

    // Assert
    expect(getQuota().used(PRIMARY_MODEL)).toBe(2);
    expect(getQuota().used(FALLBACK_MODEL)).toBe(2);
  });

  test("treats an error object returned with HTTP 200 as a failure, not an empty answer", async () => {
    // Arrange: OpenRouter does this when an upstream provider dies mid-request.
    // Reading it as a successful empty completion is how a dead model 404s silently
    // for a week while every email gets filed as 'not job related'.
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: 502, message: "upstream died" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(ok("Offer"));

    // Act
    const result = await complete(request);

    // Assert
    expect(result.content).toBe("Offer");
    expect(result.attempts).toBe(2);
  });

  test("treats a network failure as retryable rather than fatal", async () => {
    // Arrange
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValueOnce(ok("Applied"));

    // Act
    const result = await complete(request);

    // Assert
    expect(result.content).toBe("Applied");
  });

  test("fails fast and identically on every model when the API key is missing", async () => {
    // Arrange
    delete process.env.OPENROUTER_API_KEY;

    // Act
    const error = await complete(request).catch((err) => err);

    // Assert
    expect(error).toBeInstanceOf(LlmUnavailableError);
    expect((error as Error).message).toContain("OPENROUTER_API_KEY not set");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
