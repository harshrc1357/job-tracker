import { describe, expect, test } from "vitest";
import { parseId } from "./parseId";

describe("parseId", () => {
  test.each([
    ["1", 1],
    ["42", 42],
    ["999999999", 999_999_999],
  ])("reads %p as %i", (raw, expected) => {
    expect(parseId(raw)).toBe(expected);
  });

  // Number() accepted several of these ("1e3", "0x10", " 7 "), and a value past the
  // int4 range reached Postgres as a type error and came back as a 500.
  test.each(["", "0", "-1", "1.5", "1e3", "0x10", " 7 ", "7 ", "abc", "1000000000", "99999999999999999999", "٣"])(
    "refuses %p",
    (raw) => {
      expect(parseId(raw)).toBeNull();
    }
  );

  test.each([null, undefined, 7, {}, ["1"], new File(["x"], "x.txt")])("refuses the non-string %p", (raw) => {
    expect(parseId(raw)).toBeNull();
  });
});
