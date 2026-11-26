import { describe, expect, test } from "vitest";
import { hasUsableEmployer, isNonRole } from "./normalize";

// The Review page uses this to decide whether "New application" would be named after a company.
// It must agree with the Linker, which sends these same strings to Review as "unresolved".
describe("hasUsableEmployer", () => {
  test.each([
    "Alderwood",
    "Dunmore / Everly",
    "Hewlett Packard Enterprise (HPE)",
    "KVG? (brand/organization not explicit in body)",
    "Acme via Greenhouse",
  ])("%j names an employer", (raw) => {
    expect(hasUsableEmployer(raw)).toBe(true);
  });

  test.each([
    null,
    "",
    "iCIMS",
    "LinkedIn",
    "talentpluto",
    "Pluto (YC) via Pluto",
    "[company name]",
    "the role you applied to through Pluto (via Pluto)",
    "ZipRecruiter (alert) – multiple job listings; not a single employer",
    "AI Engineer I (role) not an employer; extract real employer from body is null",
  ])("%j names no employer", (raw) => {
    expect(hasUsableEmployer(raw)).toBe(false);
  });
});

// A verification mail's "role" is a sentence about a code. A job title that holds the same words is a role.
describe("isNonRole: security code", () => {
  test.each([
    "Your security code",
    "Security code for your application to Ironwood Create",
    "security code",
  ])("%j is no role", (role) => {
    expect(isNonRole(role, "Ironwood Create")).toBe(true);
  });

  test.each([
    "Security Code Reviewer",
    "Senior Security Code Auditor",
  ])("%j is a role", (role) => {
    expect(isNonRole(role, "Acme")).toBe(false);
  });
});
