import { describe, expect, test } from "vitest";
import { isRateLimit } from "./isRateLimit";

describe("isRateLimit", () => {
  test("recognises the Groq daily-quota error verbatim", () => {
    // Arrange: this is the real string that came back from production, wrapped by
    // the model client. Recognising it is what lets the run stop instead of burning
    // its whole budget on calls that cannot succeed.
    const err = new Error(
      'Groq request failed: 429 {"error":{"message":"Rate limit reached for model ' +
        "`google/gemini-2.5-flash-lite` in organization `org_01jz` service tier `on_demand` on " +
        'requests per day (RPD): Limit 250, Used 250, Requested 1.","type":"requests",' +
        '"code":"rate_limit_exceeded"}}'
    );

    // Act & Assert
    expect(isRateLimit(err)).toBe(true);
  });

  test("recognises a bare 429 and the textual variants", () => {
    expect(isRateLimit(new Error("Request failed: 429"))).toBe(true);
    expect(isRateLimit(new Error("rate_limit_exceeded"))).toBe(true);
    expect(isRateLimit(new Error("Rate limit reached"))).toBe(true);
    expect(isRateLimit(new Error("Too Many Requests"))).toBe(true);
  });

  test("does not fire on unrelated failures", () => {
    // Arrange: these must keep flowing through the ordinary error path. Treating a
    // Gmail 404 as a rate limit would abandon the rest of the run for no reason.
    expect(isRateLimit(new Error("Gmail request failed: 404 not found"))).toBe(false);
    expect(isRateLimit(new Error("OPENROUTER_API_KEY not set"))).toBe(false);
    expect(isRateLimit(new Error("connect ETIMEDOUT"))).toBe(false);
  });

  test("does not false-positive on a 429 appearing inside an unrelated number", () => {
    // Arrange: a message id or job number containing 429 is not a rate limit.
    const err = new Error("message 1a0764291bcc70ac: failed to parse body");

    // Act & Assert
    expect(isRateLimit(err)).toBe(false);
  });

  test("handles non-Error values without throwing", () => {
    expect(isRateLimit("429 Too Many Requests")).toBe(true);
    expect(isRateLimit(null)).toBe(false);
    expect(isRateLimit(undefined)).toBe(false);
    expect(isRateLimit({ weird: true })).toBe(false);
  });
});
