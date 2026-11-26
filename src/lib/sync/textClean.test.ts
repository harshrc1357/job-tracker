import { describe, expect, test } from "vitest";
import { MAX_RAW_HTML_CHARS, capChars, stripControlChars, stripHtml } from "./textClean";

// A hostile message is the whole reason these helpers exist, so the timing tests use
// input sized like the largest HTML the sync accepts. The old regexes took 14s on 200 KB.
const TIME_LIMIT_MS = 2_000;

function timeOf(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

describe("stripControlChars", () => {
  test("removes the NUL byte that Postgres rejects in text", () => {
    expect(stripControlChars("a\u0000b")).toBe("ab");
  });

  test("removes other control characters but keeps tab, newline and carriage return", () => {
    expect(stripControlChars("a\u0001\u0008b\tc\nd\re\u007ff")).toBe("ab\tc\nd\ref");
  });

  test("leaves ordinary and non-latin text alone", () => {
    expect(stripControlChars("Ünïcode 面接 ✓")).toBe("Ünïcode 面接 ✓");
  });
});

describe("capChars", () => {
  test("returns text at or under the limit unchanged", () => {
    expect(capChars("abcd", 4)).toBe("abcd");
  });

  test("cuts text over the limit", () => {
    expect(capChars("abcde", 4)).toBe("abcd");
  });
});

describe("stripHtml", () => {
  test("turns an ordinary email into plain text", () => {
    const html = "<style>p{color:red}</style><p>Hello&nbsp;there</p><div>Your interview is at 3 &amp; 4</div>";
    expect(stripHtml(html)).toBe("Hello there\nYour interview is at 3 & 4");
  });

  test("removes script and style blocks case-insensitively", () => {
    expect(stripHtml("<SCRIPT>alert(1)</SCRIPT>ok<Style>x</Style>")).toBe("ok");
  });

  test("keeps the text after a style tag that never closes", () => {
    expect(stripHtml("<style>visible text")).toBe("visible text");
  });

  test("handles a long run of '<' in linear time", () => {
    const hostile = "application interview " + "<".repeat(MAX_RAW_HTML_CHARS);
    expect(timeOf(() => stripHtml(hostile))).toBeLessThan(TIME_LIMIT_MS);
  });

  test("handles thousands of unclosed <style> and <script> tags in linear time", () => {
    const hostile = "<style>".repeat(40_000) + "<script>".repeat(30_000);
    expect(timeOf(() => stripHtml(hostile))).toBeLessThan(TIME_LIMIT_MS);
  });

  test("handles a long run of spaces with no newline in linear time", () => {
    const hostile = "a" + " ".repeat(MAX_RAW_HTML_CHARS) + "b";
    expect(timeOf(() => stripHtml(hostile))).toBeLessThan(TIME_LIMIT_MS);
  });

  test("reads at most MAX_RAW_HTML_CHARS of the input", () => {
    const html = "x".repeat(MAX_RAW_HTML_CHARS) + "<p>tail</p>";
    expect(stripHtml(html)).not.toContain("tail");
  });
});
