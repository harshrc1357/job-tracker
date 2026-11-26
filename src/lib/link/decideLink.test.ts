import { describe, expect, test } from "vitest";
import { decideLink } from "./decideLink";
import type { EmailFacts, OpenApplication } from "./types";

const NOW = new Date("2026-10-13T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

export const mail = (over: Partial<EmailFacts> = {}): EmailFacts => ({
  threadId: null,
  employer: "Alderwood",
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
  employer: "Alderwood",
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

// A staffing agency's job description is a lead, not a step in a process he is in.
describe("decideLink: Staffing/recruiter mail never makes an Application of its own", () => {
  const jd = (over: Partial<EmailFacts> = {}) => mail({ kind: "staffing", employer: "Sutton Systems", role: "Data Engineer", threadId: "t9", ...over });

  test("a job description with no Application behind its thread is ignored, not created and not asked about", () => {
    expect(decideLink(jd(), [])).toMatchObject({ action: "ignore" });
  });

  test("it is ignored even when an Application at the same employer and role exists, so nothing attaches by guess", () => {
    const decision = decideLink(jd(), [app({ id: 5, employer: "Sutton Systems", role: "Data Engineer" })]);
    expect(decision.action).toBe("ignore");
  });

  test("it never reaches Review, even when its thread is claimed by two Applications", () => {
    const apps = [app({ id: 1, threadIds: ["t9"] }), app({ id: 2, threadIds: ["t9"] })];
    expect(decideLink(jd(), apps).action).toBe("ignore");
  });

  test("once its thread belongs to an Application it joins that Application's timeline", () => {
    const decision = decideLink(jd(), [app({ id: 7, employer: "Sutton Systems", threadIds: ["t9"] })]);
    expect(decision).toMatchObject({ action: "attach", applicationId: 7, confidence: 1, flagged: false, reopen: false });
  });

  test("it does not reopen a rejected Application", () => {
    const decision = decideLink(jd(), [app({ id: 7, rejected: true, threadIds: ["t9"] })]);
    expect(decision).toMatchObject({ action: "attach", applicationId: 7, reopen: false });
  });
});

// The agency is the Employer, so every role it recruits for is one Employer to the Linker.
// These pin what that costs: a role-less follow-up is a guess, and a guess is flagged or asked.
describe("decideLink: an agency is one Employer for all of its roles (scenario 51)", () => {
  const screen = (over: Partial<EmailFacts> = {}) => mail({ kind: "screening", employer: "Sutton Systems", role: null, threadId: "t-new", ...over });
  const sutton = (id: number, role: string) => app({ id, employer: "Sutton Systems", role });

  test("a role-less Screening attaches, flagged, when exactly one Application is open at the agency", () => {
    const decision = decideLink(screen(), [sutton(3, "Data Engineer")]);
    expect(decision).toMatchObject({ action: "attach", applicationId: 3, flagged: true });
    if (decision.action === "attach") expect(decision.confidence).toBeLessThan(0.9);
  });

  test("with two open at the agency it asks instead of picking one", () => {
    expect(decideLink(screen(), [sutton(3, "Data Engineer"), sutton(4, "BI Developer")]).action).toBe("ask");
  });

  test("a Screening that names a different role at the agency is a new Application", () => {
    expect(decideLink(screen({ role: "BI Developer" }), [sutton(3, "Data Engineer")]).action).toBe("create");
  });
});

describe("decideLink: employer + role on a new thread (scenarios 2, 3, 4, 5, 9, 10, 11, 12)", () => {
  const brightfen = (id: number, role: string) => app({ id, employer: "Brightfen", role });

  test("exact employer and role attach silently at 0.90 or above", () => {
    const decision = decideLink(
      mail({ employer: "Brightfen", role: "AI/ML SWE Intern, Spring 2027", kind: "assessment" }),
      [brightfen(1, "AI/ML SWE Intern, Spring 2027"), brightfen(2, "SWE Intern, Core Eng / Security")],
    );
    expect(decision).toMatchObject({ action: "attach", applicationId: 1, flagged: false });
    if (decision.action === "attach") expect(decision.confidence).toBeGreaterThanOrEqual(0.9);
  });

  test("three roles at one employer on one day stay three separate targets", () => {
    const apps = [brightfen(1, "Data Engineer"), brightfen(2, "ML Engineer"), brightfen(3, "Security Engineer")];
    const decision = decideLink(mail({ employer: "Brightfen", role: "ML Engineer", kind: "assessment" }), apps);
    expect(decision).toMatchObject({ action: "attach", applicationId: 2 });
  });

  test("two near-identical roles are a rival, so it asks rather than guessing", () => {
    const apps = [brightfen(1, "Software Engineer Intern Backend"), brightfen(2, "Software Engineer Intern Frontend")];
    const decision = decideLink(mail({ employer: "Brightfen", role: "Software Engineer Intern", kind: "interview" }), apps);
    expect(decision.action).toBe("ask");
    if (decision.action === "ask") expect(decision.candidates.map((c) => c.applicationId).sort()).toEqual([1, 2]);
  });

  test("same title in a different term is a different role (Spring 2027 vs Summer 2026)", () => {
    const decision = decideLink(
      mail({ employer: "Brightfen", role: "SWE Intern Summer 2026", kind: "interview" }),
      [brightfen(1, "SWE Intern Spring 2027")],
    );
    expect(decision.action).not.toBe("attach");
  });

  test("a different team under the same title is a different role", () => {
    const decision = decideLink(
      mail({ employer: "Brightfen", role: "SWE Intern — Security", kind: "assessment" }),
      [brightfen(1, "SWE Intern — Core Eng")],
    );
    expect(decision.action).not.toBe("attach");
  });

  test("abbreviations and requisition ids do not break a match", () => {
    const decision = decideLink(
      mail({ employer: "Brightfen", role: "Software Engineer I (Req #R-00001)", kind: "interview" }),
      [brightfen(1, "SWE 1")],
    );
    expect(decision).toMatchObject({ action: "attach", applicationId: 1 });
  });

  test("assoc and associate are the same word in a rejection", () => {
    const decision = decideLink(
      mail({ employer: "Brightfen", role: "Associate Software Engineer", kind: "rejection" }),
      [brightfen(1, "Assoc. Software Engineer")],
    );
    expect(decision).toMatchObject({ action: "attach", applicationId: 1 });
  });
});

describe("decideLink: employer identity (scenarios 13, 14, 15, 16, 18)", () => {
  test("ATS mail attaches by the real employer, ignoring the via", () => {
    const decision = decideLink(
      mail({ employer: "Alderwood", via: "icims", role: "Intern - Gen AI Research Engineer", kind: "interview" }),
      [app()],
    );
    expect(decision).toMatchObject({ action: "attach", applicationId: 1 });
  });

  // Job boards and apply-for-you services carry mail for other companies. Never an Employer.
  test.each(["iCIMS", "ZipRecruiter", "Pluto", "Pluto (YC) via Pluto", "talentpluto"])("%s is never accepted as the employer", (name) => {
    const decision = decideLink(mail({ employer: name, via: "icims", kind: "interview" }), [app({ employer: name })]);
    expect(decision.action).toBe("ask");
  });

  test("an unresolved employer asks (recruiter on a personal address, agency pitch)", () => {
    expect(decideLink(mail({ employer: null, role: "Data Scientist" }), [app()]).action).toBe("ask");
  });

  test.each([
    ["HPE", "Hewlett Packard Enterprise"],
    ["Hewlett-Packard Enterprise", "HPE"],
    ["Alderwood, Inc.", "alderwood"],
  ])("%s and %s are the same employer", (a, b) => {
    const decision = decideLink(mail({ employer: a, role: "Engineer", kind: "interview" }), [app({ employer: b, role: "Engineer" })]);
    expect(decision).toMatchObject({ action: "attach", applicationId: 1 });
  });

  // Real pairs from the Review queue: the Applied email and the rejection spell one employer two ways.
  test.each([
    ["Ivybridge Incorporated", "Ivybridge"],
    ["Ravenna", "Ravenna.io, Inc."],
    ["Sorrel Technologies", "Sorrel"],
    ["QX Capital", "QX Capital Management, LLC"],
    ["Thistle", "Thistle Group"],
    ["Pemberton Omega", "Pemberton Omega Integration"],
    ["VELA", "VELA Consulting"],
    ["Hewlett Packard Enterprise (HPE)", "Hewlett Packard Enterprise"],
    ["Veltrix Global", "Veltrix Global (Jasper Interactive Entertainment)"],
    ["Marlin's", "Marlin"],
    ["Kingsley Bank Corporation", "Kingsley Bank Careers"],
    ["L&P", "L&P Careers (Lindgren & Pratt)"],
    ["AWS", "Amazon Web Services"],
    // "via X" names the platform that carried the mail, not a second company.
    ["Acme via Greenhouse", "Acme"],
    ["Fairhaven (via Fairhaven platform)", "Fairhaven"],
    // "A / B": the model gave two names. Either one is the employer.
    ["Dunmore", "Dunmore / Everly"],
    ["Everly", "Dunmore / Everly"],
    ["Umber", "Umber Recruiting / Umber"],
    ["Vireo", "Vireo/John Norwood"],
    ["QRX", "Orchard Redfern/QRX"],
    ["Willowbrook & Yarrow", "Willowbrook & Yarrow/W&Y Services"],
    ["Dunmore / Everly", "Everly"],
    // Two cards for one company in the real Pipeline.
    ["GetOrbit (Orbit)", "Orbit (Alex x Sam)"],
    ["Cedar", "Cedar Fellowship"],
  ])("%s and %s are the same employer", (a, b) => {
    const decision = decideLink(mail({ employer: a, role: "Engineer", kind: "rejection" }), [app({ employer: b, role: "Engineer" })]);
    expect(decision).toMatchObject({ action: "attach", applicationId: 1 });
  });

  // Dropping a word is only safe for words that name a kind of company, never a different company.
  test.each([
    ["Stonebridge Computer", "Stonebridge"],
    ["Zephyr", "Zephyr Health"],
    ["Tamarack Analytics", "TAMA"],
    ["Upland", "UPL"],
    ["Oakhaven Partners", "Robert Thistle LLC"],
    // A slash inside one name is not "two names": K/RO, UN/VELT, Quill40/40.
    ["RO", "K/RO"],
    ["VELT", "UN/VELT Inc."],
    ["40", "Quill40/40 Inc."],
  ])("%s and %s stay two employers", (a, b) => {
    const decision = decideLink(mail({ employer: a, role: "Engineer", kind: "rejection" }), [app({ employer: b, role: "Engineer" })]);
    expect(decision.action).not.toBe("attach");
  });

  test("a shared name stem is not the same employer (Pemberton FMC vs Pemberton Systems)", () => {
    const decision = decideLink(mail({ employer: "Pemberton FMC", role: "Graduate Consultant", kind: "assessment" }), [
      app({ employer: "Pemberton Systems", role: "Graduate Consultant" }),
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
    const decision = decideLink(mail({ employer: "Calloway", role: null, kind: "reminder" }), []);
    expect(decision.action).toBe("ask");
  });

  test("a roleless reminder with two open applications asks and lists both (Calloway mockup)", () => {
    const apps = [app({ id: 1, employer: "Calloway", role: "SWE Intern 2027" }), app({ id: 2, employer: "Calloway", role: "ML Engineer Intern" })];
    const decision = decideLink(mail({ employer: "Calloway", role: null, kind: "reminder" }), apps);
    expect(decision.action).toBe("ask");
    if (decision.action === "ask") expect(decision.candidates).toHaveLength(2);
  });
});

// Mail cannot belong to an Application that had not started yet. A rejection from July is not about
// the Application he opened in October; that one is a second try at the same employer.
describe("decideLink: mail older than the Application (re-applications)", () => {
  const rejection = (over: Partial<EmailFacts> = {}) => mail({ kind: "rejection", role: "Data Scientist", receivedAt: daysAgo(40), ...over });
  const dataScientist = (id: number, startedDaysAgo: number, over: Partial<OpenApplication> = {}) =>
    app({ id, role: "Data Scientist", appliedAt: daysAgo(startedDaysAgo), firstSeenAt: daysAgo(startedDaysAgo), ...over });

  test("a rejection from before the Application started does not close it; it asks and says why", () => {
    const decision = decideLink(rejection(), [dataScientist(1, 20)]);
    expect(decision).toMatchObject({ action: "ask", evidence: "every application at this employer started after this email" });
  });

  test("an interview from before the Application started is an earlier attempt, so it creates its own", () => {
    const decision = decideLink(rejection({ kind: "interview" }), [dataScientist(1, 20)]);
    expect(decision).toMatchObject({ action: "create", flagged: true });
  });

  test("a few hours of clock difference do not matter", () => {
    const applied = new Date(NOW.getTime() - 3 * 3_600_000);
    const decision = decideLink(rejection({ receivedAt: new Date(applied.getTime() - 3_600_000) }), [dataScientist(1, 0, { appliedAt: applied, firstSeenAt: applied })]);
    expect(decision).toMatchObject({ action: "attach", applicationId: 1 });
  });

  test("with an older and a newer Application for the same role, the rejection joins the older", () => {
    const decision = decideLink(rejection(), [dataScientist(1, 60), dataScientist(2, 10)]);
    expect(decision).toMatchObject({ action: "attach", applicationId: 1 });
  });

  test("a mail in a Gmail thread the Application already owns joins it whatever the dates say", () => {
    const decision = decideLink(rejection({ threadId: "t1" }), [dataScientist(1, 20, { threadIds: ["t1"] })]);
    expect(decision).toMatchObject({ action: "attach", applicationId: 1, confidence: 1 });
  });
});

// An Application whose Applied email named no role has nothing to compare a role against. When it is
// the only open Application at the employer, a later email that names a role is about it.
describe("decideLink: an open Application with no role at the employer", () => {
  const roleless = (id: number) => app({ id, role: null });

  test("a rejection naming a role attaches, flagged, to the only open Application when that has no role", () => {
    const decision = decideLink(mail({ kind: "rejection", role: "Forward Deployed Engineer" }), [roleless(7)]);
    expect(decision).toMatchObject({ action: "attach", applicationId: 7, flagged: true });
    if (decision.action === "attach") {
      expect(decision.confidence).toBeGreaterThanOrEqual(0.7);
      expect(decision.confidence).toBeLessThan(0.9);
    }
  });

  test("an interview naming a role joins it too, instead of creating a second Application", () => {
    const decision = decideLink(mail({ kind: "interview", role: "Forward Deployed Engineer" }), [roleless(7)]);
    expect(decision).toMatchObject({ action: "attach", applicationId: 7, flagged: true });
  });

  test("an Application with a different role does not stop the role-less one from taking it", () => {
    const decision = decideLink(mail({ kind: "rejection", role: "ML Engineer" }), [app({ id: 1, role: "Data Scientist" }), roleless(7)]);
    expect(decision).toMatchObject({ action: "attach", applicationId: 7 });
  });

  test("an Application whose role matches wins over a role-less one", () => {
    const decision = decideLink(mail({ kind: "rejection", role: "Data Scientist" }), [app({ id: 1, role: "Data Scientist" }), roleless(7)]);
    expect(decision).toMatchObject({ action: "attach", applicationId: 1, flagged: false });
  });

  test("two role-less Applications are a guess, so a rejection asks and lists both", () => {
    const decision = decideLink(mail({ kind: "rejection", role: "Forward Deployed Engineer" }), [roleless(7), roleless(8)]);
    expect(decision.action).toBe("ask");
    if (decision.action === "ask") expect(decision.candidates.map((c) => c.applicationId).sort()).toEqual([7, 8]);
  });

  test("cold outreach naming a role never joins it", () => {
    const decision = decideLink(mail({ kind: "outreach", role: "Forward Deployed Engineer" }), [roleless(7)]);
    expect(decision.action).toBe("ask");
  });

  test("a rejected role-less Application is not open, so it takes nothing", () => {
    const decision = decideLink(mail({ kind: "rejection", role: "Forward Deployed Engineer" }), [app({ id: 7, role: null, rejected: true })]);
    expect(decision.action).toBe("ask");
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

  test("the same role confirmed twice within 90 days attaches, no new application", () => {
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

  test("the reason says which part is missing: the employer has no application, or no application has that role", () => {
    const noEmployer = decideLink(reject({ employer: "Nowhere Labs", role: "Quantum Engineer" }), [app()]);
    expect(noEmployer).toMatchObject({ action: "ask", evidence: "no application at this employer" });
    const noRole = decideLink(reject({ role: "Quantum Engineer" }), [app()]);
    expect(noRole).toMatchObject({ action: "ask", evidence: "no application at this employer matches the role named in this email" });
  });

  test("a rejection whose role matches only loosely asks, because attaching it would close the application", () => {
    const apps = [app({ role: "Software Engineer", stage: "Interview" })];
    expect(decideLink(reject({ role: "Senior Software Engineer" }), apps).action).toBe("ask");
  });

  test("a rejection naming an extra team qualifier on one side asks instead of closing", () => {
    const apps = [app({ role: "Software Engineer Intern", stage: "Interview" })];
    expect(decideLink(reject({ role: "Software Engineer Intern - Security" }), apps).action).toBe("ask");
  });

  test("a loose match for any other kind still attaches, flagged", () => {
    const apps = [app({ role: "Software Engineer" })];
    expect(decideLink(mail({ kind: "interview", role: "Senior Software Engineer" }), apps)).toMatchObject({ action: "attach", flagged: true });
  });

  test("mail in a rejected thread reopens it, flagged", () => {
    const decision = decideLink(mail({ threadId: "t1", kind: "interview" }), [app({ threadIds: ["t1"], rejected: true })]);
    expect(decision).toMatchObject({ action: "attach", reopen: true, flagged: true });
  });

  test("a reminder in a rejected thread attaches but does not reopen it", () => {
    const decision = decideLink(mail({ threadId: "t1", kind: "reminder" }), [app({ threadIds: ["t1"], rejected: true })]);
    expect(decision).toMatchObject({ action: "attach", reopen: false });
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
