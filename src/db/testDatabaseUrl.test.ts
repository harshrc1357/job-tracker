import { describe, expect, test } from "vitest";
import { testDatabaseUrl } from "./testDatabaseUrl";

const PROD = "postgres://u:p@db.example.supabase.co:6543/postgres";
const DIRECT = "postgres://u:p@db.example.supabase.co:5432/postgres";
const TEST = "postgres://u:p@127.0.0.1:5433/test";

describe("testDatabaseUrl", () => {
  test("returns TEST_DATABASE_URL when it is a separate database", () => {
    expect(testDatabaseUrl({ DATABASE_URL: PROD, TEST_DATABASE_URL: TEST })).toBe(TEST);
  });

  test("refuses to run without TEST_DATABASE_URL, rather than falling back to DATABASE_URL", () => {
    expect(() => testDatabaseUrl({ DATABASE_URL: PROD })).toThrow(/needs TEST_DATABASE_URL/);
  });

  test.each([PROD, DIRECT])("refuses a TEST_DATABASE_URL that is the production database (%s)", (url) => {
    expect(() => testDatabaseUrl({ DATABASE_URL: PROD, DIRECT_URL: DIRECT, TEST_DATABASE_URL: url })).toThrow(
      /is the production database/
    );
  });
});
