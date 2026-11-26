import { describe, expect, test } from "vitest";
import { sslOption } from "./ssl";

describe("sslOption", () => {
  test.each([
    "postgres://user:pw@aws-0-eu.pooler.supabase.com:6543/postgres",
    "postgres://user:pw@db.example.supabase.co:5432/postgres",
    "postgresql://user:pw@ep-example.neon.tech/job_tracker",
  ])("asks for an encrypted connection to the remote host %s", (url) => {
    expect(sslOption(url)).toBe("require");
  });

  test.each([
    "postgres://postgres:postgres@127.0.0.1:5433/postgres",
    "postgres://user:pass@localhost:5432/unconfigured",
    "postgres://user:pw@[::1]:5432/db",
  ])("leaves the local database %s alone", (url) => {
    expect(sslOption(url)).toBeUndefined();
  });

  test.each(["?sslmode=require", "?sslmode=disable", "?ssl=true"])(
    "leaves the choice to the URL when it already says %s",
    (query) => {
      expect(sslOption(`postgres://user:pw@db.example.com:5432/postgres${query}`)).toBeUndefined();
    }
  );

  test("returns nothing for a string that is not a URL, so the driver reports the real error", () => {
    expect(sslOption("not a url")).toBeUndefined();
  });
});
