import { afterEach, describe, expect, test } from "vitest";
import { DEFAULT_LOOKBACK_DAYS, lookbackDays } from "./lookback";

afterEach(() => {
  delete process.env.SYNC_LOOKBACK_DAYS;
});

describe("lookbackDays", () => {
  test("syncs the last 60 days by default", () => {
    expect(DEFAULT_LOOKBACK_DAYS).toBe(60);
    expect(lookbackDays()).toBe(60);
  });

  test("an environment override still wins", () => {
    process.env.SYNC_LOOKBACK_DAYS = "14";
    expect(lookbackDays()).toBe(14);
  });

  test("a nonsense override falls back to 60 rather than 0 or NaN", () => {
    process.env.SYNC_LOOKBACK_DAYS = "abc";
    expect(lookbackDays()).toBe(60);
  });
});
