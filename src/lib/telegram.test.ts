import { describe, expect, test } from "vitest";
import { clip, escapeMarkdownV2 } from "./telegram";

describe("escapeMarkdownV2", () => {
  test("escapes the characters that would otherwise 400 the whole message", () => {
    // Arrange: real ATS subject lines are full of these. An unescaped one made
    // Telegram reject the send outright, so the reminder simply never arrived.
    const subject = "Your application for Senior_Engineer (Req #123) - next_steps!";

    // Act
    const escaped = escapeMarkdownV2(subject);

    // Assert
    expect(escaped).toBe(
      "Your application for Senior\\_Engineer \\(Req \\#123\\) \\- next\\_steps\\!"
    );
  });

  test("escapes backslashes before anything else so they do not double up", () => {
    // Arrange
    const text = "path\\to*thing";

    // Act
    const escaped = escapeMarkdownV2(text);

    // Assert
    expect(escaped).toBe("path\\\\to\\*thing");
  });

  test("leaves ordinary text untouched", () => {
    expect(escapeMarkdownV2("Interview with Acme on Tuesday")).toBe(
      "Interview with Acme on Tuesday"
    );
  });

  test("handles empty input", () => {
    expect(escapeMarkdownV2("")).toBe("");
  });
});

describe("clip", () => {
  test("leaves text at or under the limit alone", () => {
    expect(clip("abcd", 4)).toBe("abcd");
  });

  test("cuts longer text to the limit, ending in an ellipsis", () => {
    expect(clip("abcdef", 4)).toBe("abc…");
  });

  test("a clipped, escaped subject stays under Telegram's 4096-character limit", () => {
    const hostile = "_".repeat(5_000);
    expect(escapeMarkdownV2(clip(hostile, 150)).length).toBeLessThan(4096);
  });
});
