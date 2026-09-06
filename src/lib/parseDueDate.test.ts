import { describe, expect, test } from "vitest";
import { parseDueDate } from "./parseDueDate";

const CENTRAL = "America/Chicago";

describe("parseDueDate", () => {
  test("reads a bare datetime as local time in the owner's zone, not the server's", () => {
    // Arrange: the LLM almost always returns an offset-less ISO string. Vercel runs
    // in UTC, so `new Date(raw)` silently treated 2pm Central as 2pm UTC — every
    // reminder landed 5 hours early.
    const raw = "2026-09-10T14:00:00";

    // Act
    const parsed = parseDueDate(raw, CENTRAL);

    // Assert: September is CDT, UTC-5.
    expect(parsed?.toISOString()).toBe("2026-09-10T19:00:00.000Z");
  });

  test("resolves against the zone it is given, not the machine's own zone", () => {
    // Arrange: this is the test that actually pins the bug. The dev machine is
    // already Central, so a Central-only assertion passes against the old broken
    // `new Date(raw)` too. A zone the runner is definitely not in cannot.
    const raw = "2026-09-10T14:00:00";

    // Act
    const parsed = parseDueDate(raw, "Asia/Kolkata");

    // Assert: IST is UTC+5:30 year round.
    expect(parsed?.toISOString()).toBe("2026-09-10T08:30:00.000Z");
  });

  test("applies standard time offset for a winter date", () => {
    // Arrange: December is CST, UTC-6. A fixed offset would get one of these wrong.
    const raw = "2026-12-10T14:00:00";

    // Act
    const parsed = parseDueDate(raw, CENTRAL);

    // Assert
    expect(parsed?.toISOString()).toBe("2026-12-10T20:00:00.000Z");
  });

  test("respects an explicit UTC marker instead of re-zoning it", () => {
    // Arrange
    const raw = "2026-09-10T14:00:00Z";

    // Act
    const parsed = parseDueDate(raw, CENTRAL);

    // Assert
    expect(parsed?.toISOString()).toBe("2026-09-10T14:00:00.000Z");
  });

  test("respects an explicit numeric offset", () => {
    // Arrange
    const raw = "2026-09-10T14:00:00-04:00";

    // Act
    const parsed = parseDueDate(raw, CENTRAL);

    // Assert
    expect(parsed?.toISOString()).toBe("2026-09-10T18:00:00.000Z");
  });

  test("handles a date with no time as midnight in the owner's zone", () => {
    // Arrange
    const raw = "2026-09-10";

    // Act
    const parsed = parseDueDate(raw, CENTRAL);

    // Assert
    expect(parsed?.toISOString()).toBe("2026-09-10T05:00:00.000Z");
  });

  test("returns null when the model says there is no date", () => {
    expect(parseDueDate("None", CENTRAL)).toBeNull();
    expect(parseDueDate("none.", CENTRAL)).toBeNull();
  });

  test("returns null for empty or unparseable input", () => {
    expect(parseDueDate("", CENTRAL)).toBeNull();
    expect(parseDueDate("   ", CENTRAL)).toBeNull();
    expect(parseDueDate("sometime next week", CENTRAL)).toBeNull();
  });
});
