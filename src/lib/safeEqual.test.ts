import { describe, expect, test } from "vitest";
import { safeEqual } from "./safeEqual";

describe("safeEqual", () => {
  test("is true for identical strings", () => {
    expect(safeEqual("s3cret-value", "s3cret-value")).toBe(true);
  });

  test("is false for strings that differ by one character", () => {
    expect(safeEqual("s3cret-value", "s3cret-valuf")).toBe(false);
  });

  test("is false for strings of different length, without throwing", () => {
    expect(safeEqual("short", "a much longer string")).toBe(false);
  });

  test("is false when one side is empty and the other is not", () => {
    expect(safeEqual("", "x")).toBe(false);
  });
});
