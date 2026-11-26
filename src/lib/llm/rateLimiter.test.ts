import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { createRateLimiter } from "./rateLimiter";

// The limiter is the only thing standing between SYNC_CONCURRENCY parallel workers
// and a provider 429. Fake timers throughout: a real-clock test for a per-minute
// budget would either take a minute or prove nothing.
describe("createRateLimiter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("lets the first burst through immediately up to the bucket size", async () => {
    // Arrange
    const limiter = createRateLimiter({ requestsPerMinute: 60, burst: 5 });

    // Act: five acquires with no time passing
    const settled = await Promise.all(
      Array.from({ length: 5 }, () => limiter.acquire().then(() => "ok"))
    );

    // Assert
    expect(settled).toEqual(["ok", "ok", "ok", "ok", "ok"]);
  });

  test("makes the request past the burst wait for a refill", async () => {
    // Arrange: 60/min means one token per second.
    const limiter = createRateLimiter({ requestsPerMinute: 60, burst: 2 });
    await limiter.acquire();
    await limiter.acquire();

    // Act
    let released = false;
    const pending = limiter.acquire().then(() => {
      released = true;
    });

    await vi.advanceTimersByTimeAsync(500);
    const releasedEarly = released;

    await vi.advanceTimersByTimeAsync(600);
    await pending;

    // Assert
    expect(releasedEarly).toBe(false);
    expect(released).toBe(true);
  });

  test("paces a queue of waiters instead of releasing them together", async () => {
    // Arrange: this is the actual failure mode. Six concurrent workers all calling
    // acquire() must come out spread across the minute, not in one clump.
    const limiter = createRateLimiter({ requestsPerMinute: 60, burst: 1 });
    const releaseTimes: number[] = [];
    const start = Date.now();

    // Act
    const all = Promise.all(
      Array.from({ length: 4 }, () =>
        limiter.acquire().then(() => releaseTimes.push(Date.now() - start))
      )
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await all;

    // Assert: one immediately, then roughly one per second.
    expect(releaseTimes).toHaveLength(4);
    expect(releaseTimes[0]).toBeLessThan(100);
    expect(releaseTimes[3]).toBeGreaterThanOrEqual(2_900);
  });

  test("rejects a non-positive rate rather than dividing by zero", () => {
    expect(() => createRateLimiter({ requestsPerMinute: 0 })).toThrow(/requestsPerMinute/);
  });
});
