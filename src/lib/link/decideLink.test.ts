import { describe, expect, test } from "vitest";
import { decideLink } from "./decideLink";
import type { EmailFacts, OpenApplication } from "./types";

const NOW = new Date("2026-10-13T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

export const mail = (over: Partial<EmailFacts> = {}): EmailFacts => ({
  threadId: null,
  employer: "Cotiviti",
  role: null,
  via: null,
  kind: "interview",
  fromMe: false,
  receivedAt: NOW,
  round: null,
  ...over,
});

export const app = (over: Partial<OpenApplication> = {}): OpenApplication => ({
  id: 1,
  employer: "Cotiviti",
  role: "Intern - Gen AI Research Engineer",
  stage: "Applied",
  rejected: false,
  appliedAt: daysAgo(20),
  firstSeenAt: daysAgo(20),
  threadIds: [],
  ...over,
});

describe("decideLink: thread id is the strongest evidence (scenarios 1, 8)", () => {
  test("a reply in a known thread attaches silently at 1.00", () => {
    const decision = decideLink(mail({ threadId: "t1", role: null }), [app({ threadIds: ["t1"] })]);
    expect(decision).toMatchObject({ action: "attach", applicationId: 1, confidence: 1, flagged: false });
  });

  test("the thread wins even when the email names a different role", () => {
    const apps = [
      app({ id: 1, role: "Data Scientist", threadIds: ["t1"] }),
      app({ id: 2, role: "ML Engineer" }),
    ];
    const decision = decideLink(mail({ threadId: "t1", role: "ML Engineer" }), apps);
    expect(decision).toMatchObject({ action: "attach", applicationId: 1, confidence: 1 });
  });

  test("a thread claimed by two applications is a data problem, so it asks", () => {
    const apps = [app({ id: 1, threadIds: ["t1"] }), app({ id: 2, threadIds: ["t1"] })];
    expect(decideLink(mail({ threadId: "t1" }), apps).action).toBe("ask");
  });

  test("the thread still wins when the employer could not be extracted", () => {
    const decision = decideLink(mail({ threadId: "t1", employer: null }), [app({ threadIds: ["t1"] })]);
    expect(decision).toMatchObject({ action: "attach", confidence: 1 });
  });
});

describe("decideLink: mail that never touches an application (scenarios 35, 36, 38)", () => {
  test.each(["verification", "marketing"] as const)("%s mail is ignored", (kind) => {
    expect(decideLink(mail({ kind }), [app()]).action).toBe("ignore");
  });

  test("my own reply in a known thread attaches as an event", () => {
    const decision = decideLink(mail({ fromMe: true, threadId: "t1" }), [app({ threadIds: ["t1"] })]);
    expect(decision).toMatchObject({ action: "attach", confidence: 1 });
  });

  test("my own reply that matches nothing never creates an application", () => {
    const decision = decideLink(mail({ fromMe: true, employer: "Nowhere Inc", kind: "applied" }), []);
    expect(decision.action).toBe("ignore");
  });
});

describe("decideLink: employer + role on a new thread (scenarios 2, 3, 4, 5, 9, 10, 11, 12)", () => {
  const snowflake = (id: number, role: string) => app({ id, employer: "Snowflake", role });

  test("exact employer and role attach silently at 0.90 or above", () => {
    const decision = decideLink(
      mail({ employer: "Snowflake", role: "AI/ML SWE Intern, Spring 2027", kind: "assessment" }),
      [snowflake(1, "AI/ML SWE Intern, Spring 2027"), snowflake(2, "SWE Intern, Core Eng / Security")],
    );
    expect(decision).toMatchObject({ action: "attach", applicationId: 1, flagged: false });
    if (decision.action === "attach") expect(decision.confidence).toBeGreaterThanOrEqual(0.9);
  });

  test("three roles at one employer on one day stay three separate targets", () => {
    const apps = [snowflake(1, "Data Engineer"), snowflake(2, "ML Engineer"), snowflake(3, "Security Engineer")];
    const decision = decideLink(mail({ employer: "Snowflake", role: "ML Engineer", kind: "assessment" }), apps);
    expect(decision).toMatchObject({ action: "attach", applicationId: 2 });
  });

  test("two near-identical roles are a rival, so it asks rather than guessing", () => {
    const apps = [snowflake(1, "Software Engineer Intern Backend"), snowflake(2, "Software Engineer Intern Frontend")];
    const decision = decideLink(mail({ employer: "Snowflake", role: "Software Engineer Intern", kind: "interview" }), apps);
    expect(decision.action).toBe("ask");
    if (decision.action === "ask") expect(decision.candidates.map((c) => c.applicationId).sort()).toEqual([1, 2]);
  });

  test("same title in a different term is a different role (Spring 2027 vs Summer 2026)", () => {
    const decision = decideLink(
      mail({ employer: "Snowflake", role: "SWE Intern Summer 2026", kind: "interview" }),
      [snowflake(1, "SWE Intern Spring 2027")],
    );
    expect(decision.action).not.toBe("attach");
  });

  test("a different team under the same title is a different role", () => {
    const decision = decideLink(
      mail({ employer: "Snowflake", role: "SWE Intern — Security", kind: "assessment" }),
      [snowflake(1, "SWE Intern — Core Eng")],
    );
    expect(decision.action).not.toBe("attach");
  });

  test("abbreviations and requisition ids do not break a match", () => {
    const decision = decideLink(
      mail({ employer: "Snowflake", role: "Software Engineer I (Req #R-48213)", kind: "interview" }),
      [snowflake(1, "SWE 1")],
    );
    expect(decision).toMatchObject({ action: "attach", applicationId: 1 });
  });
});

describe("decideLink: employer identity (scenarios 13, 14, 15, 16, 18)", () => {
  test("ATS mail attaches by the real employer, ignoring the via", () => {
    const decision = decideLink(
      mail({ employer: "Cotiviti", via: "icims", role: "Intern - Gen AI Research Engineer", kind: "interview" }),
      [app()],
    );
    expect(decision).toMatchObject({ action: "attach", applicationId: 1 });
  });

  test("an ATS name is never accepted as the employer", () => {
    const decision = decideLink(mail({ employer: "iCIMS", via: "icims", kind: "interview" }), [app({ employer: "iCIMS" })]);
    expect(decision.action).toBe("ask");
  });

  test("an unresolved employer asks (recruiter on a personal address, agency pitch)", () => {
    expect(decideLink(mail({ employer: null, role: "Data Scientist" }), [app()]).action).toBe("ask");
  });

  test.each([
    ["HPE", "Hewlett Packard Enterprise"],
    ["Hewlett-Packard Enterprise", "HPE"],
    ["Cotiviti, Inc.", "cotiviti"],
  ])("%s and %s are the same employer", (a, b) => {
    const decision = decideLink(mail({ employer: a, role: "Engineer", kind: "interview" }), [app({ employer: b, role: "Engineer" })]);
    expect(decision).toMatchObject({ action: "attach", applicationId: 1 });
  });

  test("a shared name stem is not the same employer (Alpha FMC vs Alpha Systems)", () => {
    const decision = decideLink(mail({ employer: "Alpha FMC", role: "Graduate Consultant", kind: "assessment" }), [
      app({ employer: "Alpha Systems", role: "Graduate Consultant" }),
    ]);
    expect(decision.action).not.toBe("attach");
  });
});

describe("decideLink: role missing from the email (scenarios 6, 7, 39)", () => {
  test("no role and exactly one open application at the employer attaches, flagged", () => {
    const decision = decideLink(mail({ role: null, kind: "assessment" }), [app()]);
    expect(decision).toMatchObject({ action: "attach", applicationId: 1, flagged: true });
    if (decision.action === "attach") {
      expect(decision.confidence).toBeGreaterThanOrEqual(0.7);
      expect(decision.confidence).toBeLessThan(0.9);
    }
  });

  test("no role and several open applications at the employer asks, listing them", () => {
    const decision = decideLink(mail({ role: null, kind: "interview" }), [app({ id: 1 }), app({ id: 2, role: "Data Scientist" })]);
    expect(decision.action).toBe("ask");
    if (decision.action === "ask") {
      expect(decision.confidence).toBeLessThan(0.7);
      expect(decision.candidates).toHaveLength(2);
    }
  });

  test("a rejected application does not count as open for a roleless email", () => {
    const apps = [app({ id: 1, rejected: true }), app({ id: 2, role: "Data Scientist" })];
    expect(decideLink(mail({ role: null, kind: "interview" }), apps)).toMatchObject({ action: "attach", applicationId: 2 });
  });

  test("a calendar invite with no role and no thread falls back to the same rules", () => {
    const decision = decideLink(mail({ role: null, kind: "interview", via: "calendly" }), [app({ id: 1 }), app({ id: 2, role: "ML Engineer" })]);
    expect(decision.action).toBe("ask");
  });
});

describe("decideLink: a role we have no application for (scenarios 20, 21, 37)", () => {
  test("an interview for a role with no application creates one, flagged (Applied email never arrived)", () => {
    const decision = decideLink(mail({ role: "Platform Engineer", kind: "interview" }), [app()]);
    expect(decision).toMatchObject({ action: "create", flagged: true });
  });

  test("a screening invite from an employer with no applications creates one, role unknown", () => {
    const decision = decideLink(mail({ employer: "Hewlett Packard Enterprise", role: null, kind: "screening" }), []);
    expect(decision).toMatchObject({ action: "create", flagged: true });
  });

  test("cold recruiter outreach with no matching application asks instead of creating", () => {
    const decision = decideLink(mail({ employer: "Magpie Health Analytics", role: null, kind: "outreach" }), []);
    expect(decision.action).toBe("ask");
  });

  test("a roleless reminder with no application at the employer asks", () => {
    const decision = decideLink(mail({ employer: "Roblox", role: null, kind: "reminder" }), []);
    expect(decision.action).toBe("ask");
  });

  test("a roleless reminder with two open applications asks and lists both (Roblox mockup)", () => {
    const apps = [app({ id: 1, employer: "Roblox", role: "SWE Intern 2027" }), app({ id: 2, employer: "Roblox", role: "ML Engineer Intern" })];
    const decision = decideLink(mail({ employer: "Roblox", role: null, kind: "reminder" }), apps);
    expect(decision.action).toBe("ask");
    if (decision.action === "ask") expect(decision.candidates).toHaveLength(2);
  });
});

describe("decideLink: Applied emails and the 90-day window (scenarios 2, 31, 32, 33, 34)", () => {
  const applied = (over: Partial<EmailFacts> = {}) => mail({ kind: "applied", role: "Data Engineer", ...over });

  test("a first application at an employer creates a new application", () => {
    expect(decideLink(applied(), [])).toMatchObject({ action: "create", flagged: false });
  });

  test("a second role at the same employer creates a second application", () => {
    const decision = decideLink(applied({ role: "ML Engineer" }), [app({ role: "Data Engineer", appliedAt: daysAgo(0) })]);
    expect(decision.action).toBe("create");
  });

  test("the same role confirmed twice within 90 days attaches, no new card", () => {
    const decision = decideLink(applied(), [app({ role: "Data Engineer", appliedAt: daysAgo(30) })]);
    expect(decision).toMatchObject({ action: "attach", applicationId: 1 });
  });

  test("the same role after 90 days is a new application", () => {
    const decision = decideLink(applied(), [app({ role: "Data Engineer", appliedAt: daysAgo(120) })]);
    expect(decision.action).toBe("create");
  });

  test("reapplying after a rejection starts a new application, flagged", () => {
    const decision = decideLink(applied(), [app({ role: "Data Engineer", appliedAt: daysAgo(40), rejected: true })]);
    expect(decision).toMatchObject({ action: "create", flagged: true });
  });

  test("an Applied email with no role never merges into an existing application", () => {
    const decision = decideLink(applied({ role: null }), [app({ role: "Data Engineer", appliedAt: daysAgo(1) })]);
    expect(decision).toMatchObject({ action: "create", flagged: true });
  });

  test("an Applied email that arrives after the interview email attaches to the application it created", () => {
    const decision = decideLink(applied({ receivedAt: daysAgo(5) }), [
      app({ role: "Data Engineer", appliedAt: null, firstSeenAt: daysAgo(2), stage: "Interview" }),
    ]);
    expect(decision).toMatchObject({ action: "attach", applicationId: 1 });
  });
});

describe("decideLink: rejections never close the wrong thing (scenarios 26, 27, 28, 29, 30)", () => {
  const reject = (over: Partial<EmailFacts> = {}) => mail({ kind: "rejection", ...over });

  test("a rejection naming the role targets only that application", () => {
    const apps = [app({ id: 1, role: "Data Scientist", stage: "Interview" }), app({ id: 2, role: "ML Engineer" })];
    expect(decideLink(reject({ role: "ML Engineer" }), apps)).toMatchObject({ action: "attach", applicationId: 2 });
  });

  test("a roleless rejection with one open application targets it", () => {
    expect(decideLink(reject(), [app()])).toMatchObject({ action: "attach", applicationId: 1 });
  });

  test("a roleless rejection with a live interview and another application asks, never auto-closes", () => {
    const apps = [app({ id: 1, stage: "Interview" }), app({ id: 2, role: "Data Scientist" })];
    const decision = decideLink(reject(), apps);
    expect(decision.action).toBe("ask");
  });

  test("a rejection for a role we do not know asks rather than inventing a rejected application", () => {
    expect(decideLink(reject({ role: "Quantum Engineer" }), [app()]).action).toBe("ask");
  });

  test("mail in a rejected thread reopens it, flagged", () => {
    const decision = decideLink(mail({ threadId: "t1", kind: "interview" }), [app({ threadIds: ["t1"], rejected: true })]);
    expect(decision).toMatchObject({ action: "attach", reopen: true, flagged: true });
  });

  test("a duplicate Applied email in a rejected thread does not reopen it", () => {
    const decision = decideLink(mail({ threadId: "t1", kind: "applied" }), [app({ threadIds: ["t1"], rejected: true })]);
    expect(decision).toMatchObject({ action: "attach", reopen: false });
  });

  test("a rejection arriving in an already-rejected thread does not reopen it", () => {
    const decision = decideLink(mail({ threadId: "t1", kind: "rejection" }), [app({ threadIds: ["t1"], rejected: true })]);
    expect(decision).toMatchObject({ action: "attach", reopen: false });
  });
});
