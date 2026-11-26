import { describe, expect, test } from "vitest";
import { parseDueDate } from "./parseDueDate";

// A date the model invents must not reach the database. Postgres has no year 0, and a
// row it refuses blocks the whole batch of mail stored with it.
describe("parseDueDate range", () => {
  const zone = "America/Chicago";

  test.each(["0000-01-01T00:00:00Z", "0000-01-01", "1999-12-31T23:59:59Z", "2101-01-01T00:00:00Z", "+275760-09-13T00:00:00Z"])(
    "refuses %s as outside the years 2000 to 2100",
    (raw) => {
      expect(parseDueDate(raw, zone)).toBeNull();
    }
  );

  test.each(["2026-10-21T17:00:00Z", "2026-10-21", "2026-10-21 17:00"])("still accepts %s", (raw) => {
    expect(parseDueDate(raw, zone)).toBeInstanceOf(Date);
  });
});
