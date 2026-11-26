// A row id from a URL or a form field. Number() accepts "1e3", "0x10" and " 7 ", and a
// value past the 32-bit integer range reaches Postgres as a type error that surfaces as
// a 500. Plain digits only, no leading zero, at most nine of them (always inside int4).
const ID_PATTERN = /^[1-9]\d{0,8}$/;

export function parseId(value: unknown): number | null {
  return typeof value === "string" && ID_PATTERN.test(value) ? Number(value) : null;
}
