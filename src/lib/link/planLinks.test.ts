import { describe, expect, test } from "vitest";
import { planLinks, type LinkableEmail, type TrackedApplication } from "./planLinks";

const day = (n: number) => new Date(Date.UTC(2026, 8, 1 + n, 12));

let nextId = 1;
const email = (over: Partial<LinkableEmail> = {}): LinkableEmail => ({
  emailId: nextId++,
  threadId: null,
  employer: "Cotiviti",
  role: "Data Scientist I",
  via: null,
  kind: "applied",
  fromMe: false,
  receivedAt: day(0),
  round: null,
  ...over,
});

const tracked = (over: Partial<TrackedApplication> = {}): TrackedApplication => ({
  id: 1,
  employer: "Cotiviti",
  role: "Data Scientist I",
  stage: "Applied",
  rejected: false,
  appliedAt: day(0),
  firstSeenAt: day(0),
  threadIds: [],
  via: null,
  round: 0,
  flags: [],
  lastActivityAt: day(0),
  ...over,
});

const byEmail = (plan: ReturnType<typeof planLinks>, emailId: number) => plan.results.find((r) => r.emailId === emailId)!;

describe("planLinks: volume (scenario 41)", () => {
  test("30 new Applied emails in one run become 30 applications and ask nothing", () => {
    const emails = Array.from({ length: 30 }, (_, i) => email({ employer: `Company ${i}`, role: "Software Engineer", receivedAt: day(0) }));
    const plan = planLinks(emails, []);
    expect(plan.apps).toHaveLength(30);
    expect(plan.results.filter((r) => r.outcome === "review")).toHaveLength(0);
  });

  test("new applications get distinct negative ids so they cannot collide with stored ones", () => {
    const plan = planLinks([email({ employer: "A" }), email({ employer: "B" })], [tracked({ id: 5 })]);
    const created = plan.apps.filter((a) => a.id < 0).map((a) => a.id);
    expect(new Set(created).size).toBe(2);
  });
});

// A staffing agency sends a job description; the Application only exists once the same
// conversation turns into a screen, an assessment or an interview.
describe("planLinks: a job description joins the Application its thread later becomes", () => {
  const jd = (over: Partial<LinkableEmail> = {}) =>
    email({ kind: "staffing", employer: "Apex Systems", role: "Data Engineer", threadId: "t-apex", receivedAt: day(0), ...over });
  const screen = (over: Partial<LinkableEmail> = {}) =>
    email({ kind: "screening", employer: "Apex Systems", role: "Data Engineer", threadId: "t-apex", receivedAt: day(2), ...over });

  test("on its own it is ignored: no Application, no Review item", () => {
    const only = jd();
    const plan = planLinks([only], []);
    expect(plan.apps).toHaveLength(0);
    expect(byEmail(plan, only.emailId)).toMatchObject({ outcome: "ignored", applicationId: null });
  });

  test("in the same batch: the screen creates the Application under the agency and the job description joins it", () => {
    const first = jd();
    const second = screen();
    const plan = planLinks([first, second], []);
    expect(plan.apps).toHaveLength(1);
    expect(plan.apps[0]).toMatchObject({ employer: "Apex Systems", stage: "Screening", firstSeenAt: day(0), lastActivityAt: day(2) });
    expect(byEmail(plan, first.emailId)).toMatchObject({ outcome: "attached", applicationId: plan.apps[0].id, confidence: 1 });
    expect(plan.results).toHaveLength(2);
  });

  test("stored earlier: the screen creates the Application and the earlier job description is linked to it", () => {
    const stored = { emailId: 900, threadId: "t-apex", receivedAt: day(0) };
    const second = screen();
    const plan = planLinks([second], [], [stored]);
    expect(plan.apps).toHaveLength(1);
    expect(byEmail(plan, 900)).toMatchObject({ outcome: "attached", applicationId: plan.apps[0].id });
    expect(plan.apps[0].firstSeenAt).toEqual(day(0));
  });

  test("it joins an existing Application too, when the screen attaches to it by employer and role", () => {
    const existing = tracked({ id: 4, employer: "Apex Systems", role: "Data Engineer", threadIds: [] });
    const plan = planLinks([screen({ threadId: "t-new" })], [existing], [{ emailId: 901, threadId: "t-new", receivedAt: day(0) }]);
    expect(byEmail(plan, 901)).toMatchObject({ outcome: "attached", applicationId: 4 });
  });

  test("a job description in another thread is left alone", () => {
    const plan = planLinks([screen()], [], [{ emailId: 902, threadId: "t-other", receivedAt: day(0) }]);
    expect(plan.results.find((r) => r.emailId === 902)).toBeUndefined();
  });

  test.each(["reminder", "verification", "applied"] as const)("only mail that moves the process forward adopts: %s does not", (kind) => {
    const plan = planLinks([email({ kind, employer: "Apex Systems", role: "Data Engineer", threadId: "t-apex", receivedAt: day(2) })], [], [{ emailId: 903, threadId: "t-apex", receivedAt: day(0) }]);
    expect(plan.results.find((r) => r.emailId === 903)).toBeUndefined();
  });

  test("my own reply in the thread is not evidence that a process began", () => {
    const plan = planLinks([screen({ fromMe: true })], [tracked({ id: 4, employer: "Apex Systems", role: "Data Engineer", threadIds: ["t-apex"] })], [{ emailId: 904, threadId: "t-apex", receivedAt: day(0) }]);
    expect(plan.results.find((r) => r.emailId === 904)).toBeUndefined();
  });

  test("adopting an older job description leaves the stage and last activity alone; the Application now starts when it arrived", () => {
    const existing = tracked({ id: 4, employer: "Apex Systems", role: "Data Engineer", stage: "Interview", round: 1, threadIds: ["t-apex"], firstSeenAt: day(3), lastActivityAt: day(9) });
    const plan = planLinks([screen({ kind: "assessment", receivedAt: day(5) })], [existing], [{ emailId: 905, threadId: "t-apex", receivedAt: day(0) }]);
    expect(plan.apps[0]).toMatchObject({ stage: "Interview", lastActivityAt: day(9), firstSeenAt: day(0) });
  });

  test("a job description that arrives later in the thread joins it, leaves the stage alone, and counts as activity like any email", () => {
    const existing = tracked({ id: 4, employer: "Apex Systems", role: "Data Engineer", stage: "Screening", threadIds: ["t-apex"], lastActivityAt: day(5) });
    const later = jd({ receivedAt: day(12) });
    const plan = planLinks([later], [existing]);
    expect(byEmail(plan, later.emailId)).toMatchObject({ outcome: "attached", applicationId: 4 });
    expect(plan.apps[0]).toMatchObject({ stage: "Screening", lastActivityAt: day(12) });
  });

  test("a second progress email in the thread does not adopt the same job description twice", () => {
    const plan = planLinks([screen(), screen({ kind: "interview", receivedAt: day(4) })], [], [{ emailId: 906, threadId: "t-apex", receivedAt: day(0) }]);
    expect(plan.results.filter((r) => r.emailId === 906)).toHaveLength(1);
  });
});

describe("planLinks: one application's life", () => {
  test("Applied, then a same-thread interview with no role, builds one application at Interview", () => {
    const applied = email({ threadId: "t1", receivedAt: day(0) });
    const interview = email({ threadId: "t1", role: null, kind: "interview", round: 2, receivedAt: day(10) });
    const plan = planLinks([applied, interview], []);
    expect(plan.apps).toHaveLength(1);
    expect(plan.apps[0]).toMatchObject({ stage: "Interview", round: 2, rejected: false });
    expect(byEmail(plan, interview.emailId)).toMatchObject({ outcome: "attached", confidence: 1 });
  });

  test("emails are processed in time order whatever order they arrive in", () => {
    const applied = email({ threadId: "t1", receivedAt: day(0) });
    const interview = email({ threadId: "t1", role: null, kind: "interview", receivedAt: day(10) });
    const forward = planLinks([applied, interview], []);
    const shuffled = planLinks([interview, applied], []);
    expect(shuffled.apps).toHaveLength(1);
    expect(shuffled.apps[0]).toMatchObject({ stage: forward.apps[0].stage, appliedAt: forward.apps[0].appliedAt });
  });

  test("an interview before any Applied email creates the application, and the late Applied email joins it", () => {
    const interview = email({ kind: "interview", receivedAt: day(5) });
    const applied = email({ kind: "applied", receivedAt: day(1) });
    // Applied is older, so it is processed first here; the reverse arrival is the point.
    const plan = planLinks([interview, applied], []);
    expect(plan.apps).toHaveLength(1);
    expect(plan.apps[0].stage).toBe("Interview");
  });

  test("a late Applied email for an application born from an interview sets its applied date", () => {
    const existing = tracked({ stage: "Interview", appliedAt: null, firstSeenAt: day(5), lastActivityAt: day(5) });
    const late = email({ kind: "applied", receivedAt: day(1) });
    const plan = planLinks([late], [existing]);
    expect(plan.apps[0]).toMatchObject({ id: 1, stage: "Interview" });
    expect(plan.apps[0].appliedAt).toEqual(day(1));
  });

  test("my own reply attaches but never moves the stage", () => {
    const existing = tracked({ stage: "Screening", threadIds: ["t1"] });
    const reply = email({ threadId: "t1", kind: "interview", fromMe: true, receivedAt: day(3) });
    const plan = planLinks([reply], [existing]);
    expect(byEmail(plan, reply.emailId)).toMatchObject({ outcome: "attached", applicationId: 1 });
    expect(plan.apps[0].stage).toBe("Screening");
  });
});

describe("planLinks: the Cotiviti case from the mockups", () => {
  test("a rejection of one role never touches the live interview for the other", () => {
    const genAi = tracked({ id: 1, role: "Intern - Gen AI Research Engineer", stage: "Interview", round: 2, threadIds: ["t-gen"] });
    const ds = tracked({ id: 2, role: "Data Scientist I - AI/ML", stage: "Screening", threadIds: ["t-ds"] });
    const rejection = email({ kind: "rejection", role: "Data Scientist I - AI/ML", threadId: "t-ds-2", receivedAt: day(20) });
    const plan = planLinks([rejection], [genAi, ds]);
    expect(plan.apps.find((a) => a.id === 2)).toMatchObject({ rejected: true });
    expect(plan.apps.find((a) => a.id === 1)).toMatchObject({ rejected: false, stage: "Interview", round: 2 });
  });

  test("a roleless rejection becomes a review item and closes nothing", () => {
    const apps = [tracked({ id: 1, stage: "Interview" }), tracked({ id: 2, role: "Other Role" })];
    const rejection = email({ kind: "rejection", role: null, receivedAt: day(20) });
    const plan = planLinks([rejection], apps);
    expect(byEmail(plan, rejection.emailId)).toMatchObject({ outcome: "review" });
    expect(plan.apps.every((a) => !a.rejected)).toBe(true);
  });
});

describe("planLinks: unlinked outcomes", () => {
  test("verification mail is ignored and leaves no trace on any application", () => {
    const plan = planLinks([email({ kind: "verification" })], []);
    expect(plan.results[0]).toMatchObject({ outcome: "ignored", applicationId: null });
    expect(plan.apps).toHaveLength(0);
  });

  test("a review result lists the candidate applications", () => {
    const apps = [tracked({ id: 1 }), tracked({ id: 2, role: "Other" })];
    const plan = planLinks([email({ kind: "interview", role: null })], apps);
    expect(plan.results[0].outcome).toBe("review");
    expect(plan.results[0].candidates.map((c) => c.applicationId).sort()).toEqual([1, 2]);
  });

  test("a thread seen on a created application links later mail in that thread", () => {
    const first = email({ employer: "Snowflake", role: "SWE Intern", threadId: "tx", receivedAt: day(0) });
    const second = email({ employer: null, role: null, kind: "assessment", threadId: "tx", receivedAt: day(2) });
    const plan = planLinks([first, second], []);
    expect(plan.apps).toHaveLength(1);
    expect(byEmail(plan, second.emailId).outcome).toBe("attached");
  });
});

describe("planLinks: what changed", () => {
  test("reports only the applications it touched, so the adapter writes only those", () => {
    const untouched = tracked({ id: 1, employer: "Roblox", role: "ML Intern" });
    const target = tracked({ id: 2, threadIds: ["t2"] });
    const plan = planLinks([email({ threadId: "t2", kind: "assessment", role: null })], [untouched, target]);
    expect([...plan.touched]).toEqual([2]);
  });
});

describe("planLinks: via (the hiring platform the mail travelled through)", () => {
  test("a new application records the platform of the email that created it", () => {
    const plan = planLinks([email({ via: "iCIMS" })], []);
    expect(plan.apps[0].via).toBe("iCIMS");
  });

  test("a later email fills a missing platform but never overwrites a known one", () => {
    const filled = planLinks([email({ kind: "interview", role: null, via: "Greenhouse", receivedAt: day(2) })], [tracked({ via: null })]);
    expect(filled.apps[0].via).toBe("Greenhouse");
    const kept = planLinks([email({ kind: "interview", role: null, via: "Greenhouse", receivedAt: day(2) })], [tracked({ via: "iCIMS" })]);
    expect(kept.apps[0].via).toBe("iCIMS");
  });
});
