import { describe, expect, test } from "vitest";
import { buildJobQuery } from "./message";

// The Gmail search is the first gate: mail it does not match is never fetched, never
// classified, and so never seen. It has to be wide enough for every kind of mail the
// classifier is meant to file, or a category exists on paper and never fills.
describe("buildJobQuery", () => {
  test("is a rolling window, not absolute dates", () => {
    expect(buildJobQuery(60)).toMatch(/^newer_than:60d /);
  });

  test.each(["application", "interview", "assessment", "offer", "OTP"])("still fetches %s mail", (term) => {
    expect(buildJobQuery(60)).toContain(term);
  });

  test.each(["recruiter", '"phone screen"', '"screening call"', '"intro call"'])(
    "fetches recruiter screens and outreach, which say %s rather than interview",
    (term) => {
      expect(buildJobQuery(60)).toContain(term);
    },
  );

  test('fetches a staffing agency\'s "job description", which often says neither application nor interview', () => {
    expect(buildJobQuery(60)).toContain('"job description"');
  });
});
