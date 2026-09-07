import { describe, expect, test } from "vitest";
import { createQuota } from "./quota";
import { FALLBACK_MODEL, PRIMARY_MODEL } from "./models";

describe("createQuota", () => {
  test("starts from the counts loaded out of the database, not from zero", () => {
    // Arrange: this is the whole reason the table exists. A serverless run that
    // starts at zero every invocation has no daily ceiling at all.
    const quota = createQuota({ [PRIMARY_MODEL.id]: PRIMARY_MODEL.requestsPerDay - 1 });

    // Act + Assert
    expect(quota.tryConsume(PRIMARY_MODEL)).toBe(true);
    expect(quota.tryConsume(PRIMARY_MODEL)).toBe(false);
  });

  test("refuses to consume past the cap and consumes nothing when it refuses", () => {
    // Arrange
    const quota = createQuota({ [PRIMARY_MODEL.id]: PRIMARY_MODEL.requestsPerDay });

    // Act
    const allowed = quota.tryConsume(PRIMARY_MODEL);

    // Assert
    expect(allowed).toBe(false);
    expect(quota.deltas()[PRIMARY_MODEL.id]).toBeUndefined();
  });

  test("budgets each model separately, so a spent primary leaves the fallback usable", () => {
    // Arrange: the point of the fallback is to survive the primary being unavailable,
    // and "out of budget" is a form of unavailable.
    const quota = createQuota({ [PRIMARY_MODEL.id]: PRIMARY_MODEL.requestsPerDay });

    // Assert
    expect(quota.hasBudget(PRIMARY_MODEL)).toBe(false);
    expect(quota.hasBudget(FALLBACK_MODEL)).toBe(true);
  });

  test("tracks deltas so a run can flush what it spent, then not double-write it", () => {
    // Arrange
    const quota = createQuota();
    quota.tryConsume(PRIMARY_MODEL);
    quota.tryConsume(PRIMARY_MODEL);
    quota.tryConsume(FALLBACK_MODEL);

    // Act
    const firstFlush = quota.deltas();
    quota.clearDeltas();
    quota.tryConsume(PRIMARY_MODEL);
    const secondFlush = quota.deltas();

    // Assert
    expect(firstFlush).toEqual({ [PRIMARY_MODEL.id]: 2, [FALLBACK_MODEL.id]: 1 });
    expect(secondFlush).toEqual({ [PRIMARY_MODEL.id]: 1 });
    // Total spend is still correct after a flush — clearing deltas must not un-spend.
    expect(quota.used(PRIMARY_MODEL)).toBe(3);
  });

  test("ignores a nonsense negative count from storage", () => {
    const quota = createQuota({ [PRIMARY_MODEL.id]: -50 });
    expect(quota.used(PRIMARY_MODEL)).toBe(0);
  });
});
