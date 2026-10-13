import { describe, expect, test } from "vitest";
import { CLASSIFIER_SYSTEM_PROMPT, parseVerdict } from "./prompt";
import { LlmError } from "@/lib/llm/errors";

// The parser sits on the one path where a mistake is unrecoverable: a verdict read
// wrongly as "not job related" gets banked in ignored_messages and that message is
// never looked at again. So the rule it encodes is asymmetric on purpose — a
// malformed skip may be read as a skip, a malformed anything-else must throw.
describe("parseVerdict", () => {
  test("reads a clean job verdict", () => {
    // Arrange
    const raw = '{"isJob": true, "category": "Assessment", "evidence": "complete the HackerRank test"}';

    // Act
    const verdict = parseVerdict(raw, "test-model");

    // Assert
    expect(verdict).toEqual({
      isJob: true,
      category: "Assessment",
      evidence: "complete the HackerRank test",
      employer: null,
      via: null,
      role: null,
      round: null,
    });
  });

  test("reads a non-job verdict with its reason", () => {
    const verdict = parseVerdict('{"isJob": false, "reason": "job advert digest"}', "test-model");
    expect(verdict).toEqual({ isJob: false, reason: "job advert digest" });
  });

  test("survives a code fence and a chatty preamble", () => {
    // Arrange: response_format json_object makes this rare, not impossible, and a
    // retry over a stray fence costs a real call.
    const raw = 'Here you go:\n```json\n{"isJob": true, "category": "Offer", "evidence": "pleased to offer"}\n```';

    // Act
    const verdict = parseVerdict(raw, "test-model");

    // Assert
    expect(verdict).toEqual({ isJob: true, category: "Offer", evidence: "pleased to offer", employer: null, via: null, role: null, round: null });
  });

  test("treats a missing isJob field as a skip rather than throwing", () => {
    // Arrange: worst case here is one advert not stored, which is the failure this
    // classifier is supposed to produce anyway.
    const verdict = parseVerdict('{"reason": "newsletter"}', "test-model");

    // Assert
    expect(verdict).toEqual({ isJob: false, reason: "newsletter" });
  });

  test("salvages a verdict cut off by max_tokens mid-evidence", () => {
    // Arrange: verbatim from a real row that threw away a correct answer over a
    // missing closing brace. The prompt fixes the field order, so a cut in evidence
    // always leaves isJob and category intact.
    const raw = '{"isJob": true, "category": "Applied", "evidence": "Thank you for appl';

    // Act
    const verdict = parseVerdict(raw, "test-model");

    // Assert
    expect(verdict).toEqual({ isJob: true, category: "Applied", evidence: "", employer: null, via: null, role: null, round: null });
  });

  test("refuses to salvage when the truncated category is not one of ours", () => {
    // Arrange: salvage must recover a stated verdict, never invent one.
    expect(() =>
      parseVerdict('{"isJob": true, "category": "Screen', "test-model")
    ).toThrow(LlmError);
  });

  test("refuses to salvage prose that merely mentions the field names", () => {
    expect(() =>
      parseVerdict('The email is job related so isJob is true and category is Applied', "test-model")
    ).toThrow(LlmError);
  });

  test("throws on unparseable output instead of guessing a skip", () => {
    // Arrange: this is the dangerous case. Silently returning "not job related" here
    // is how a model outage permanently discards an interview invite.
    expect(() => parseVerdict("I'm sorry, I can't help with that.", "test-model")).toThrow(LlmError);
  });

  test("throws when isJob is true but the category is not one of ours", () => {
    // Arrange: a hallucinated category ("Networking") must not be written to a column
    // the dashboard filters on.
    expect(() =>
      parseVerdict('{"isJob": true, "category": "Networking", "evidence": "x"}', "test-model")
    ).toThrow(/unknown category/);
  });

  test("reads a Staffing/recruiter verdict, whole or cut off by max_tokens", () => {
    // The slash in the label is the thing that can go wrong: the rescue for a cut-off
    // answer matches the category with a pattern, and a pattern of letters stops at it.
    const whole = '{"isJob": true, "category": "Staffing/recruiter", "employer": "Apex Systems", "role": "Data Engineer", "evidence": "my client is hiring"}';
    expect(parseVerdict(whole, "m")).toMatchObject({ isJob: true, category: "Staffing/recruiter", employer: "Apex Systems" });

    const cut = '{"isJob": true, "category": "Staffing/recruiter", "employer": "Apex Systems", "evidence": "my client is hir';
    expect(parseVerdict(cut, "m")).toMatchObject({ category: "Staffing/recruiter", employer: "Apex Systems" });
  });

  test("reads a Screening verdict, whole or cut off by max_tokens", () => {
    const whole = '{"isJob": true, "category": "Screening", "employer": "Cotiviti", "role": "Data Scientist I", "evidence": "quick intro call"}';
    expect(parseVerdict(whole, "m")).toMatchObject({ isJob: true, category: "Screening", employer: "Cotiviti" });

    const cut = '{"isJob": true, "category": "Screening", "employer": "Cotiviti", "evidence": "quick in';
    expect(parseVerdict(cut, "m")).toMatchObject({ category: "Screening", employer: "Cotiviti" });
  });

  test("marks parse failures as unusable, so complete() falls back instead of banking", () => {
    // Arrange
    let thrown: unknown;

    // Act
    try {
      parseVerdict("not json at all", "test-model");
    } catch (err) {
      thrown = err;
    }

    // Assert
    expect(thrown).toBeInstanceOf(LlmError);
    expect((thrown as LlmError).kind).toBe("unusable");
  });

  test("caps a runaway evidence string", () => {
    // Arrange: the model is asked for 15 words. Nothing stops it pasting the email.
    const raw = JSON.stringify({ isJob: true, category: "Applied", evidence: "x".repeat(5_000) });

    // Act
    const verdict = parseVerdict(raw, "test-model");

    // Assert
    if (!verdict.isJob) throw new Error("expected a job verdict");
    expect(verdict.evidence.length).toBeLessThanOrEqual(200);
  });
});

// The prompt is the product. These pin the two instructions that exist because of
// specific production failures, so a later reword cannot quietly drop them.
describe("CLASSIFIER_SYSTEM_PROMPT", () => {
  test("asks the job-vs-advert question before the category question", () => {
    const jobQuestion = CLASSIFIER_SYSTEM_PROMPT.indexOf("QUESTION 1");
    const stageQuestion = CLASSIFIER_SYSTEM_PROMPT.indexOf("QUESTION 2");
    expect(jobQuestion).toBeGreaterThan(-1);
    expect(stageQuestion).toBeGreaterThan(jobQuestion);
  });

  test("tells the model an advert is not a weak Applied", () => {
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain('not a weak "Applied"');
  });

  test("tells the model the subject understates and the body decides", () => {
    expect(CLASSIFIER_SYSTEM_PROMPT).toMatch(/ENTIRE body/);
    expect(CLASSIFIER_SYSTEM_PROMPT).toMatch(/Thank you for your application/);
  });

  test("states the stage priority that makes an acknowledgement-plus-test an Assessment", () => {
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain(
      "Verification > Rejection > Offer > Interview > Assessment > Screening > Staffing/recruiter > Reminder > Applied"
    );
  });
});

// Screening sits between Applied and the technical stages, so the line between it and
// Interview has to be drawn in words: both used to be "Interview" in the old prompt.
describe("CLASSIFIER_SYSTEM_PROMPT: Screening", () => {
  const line = (label: string) => CLASSIFIER_SYSTEM_PROMPT.split("\n").find((l) => l.startsWith(`- ${label}:`)) ?? "";

  test("defines Screening as a recruiter intro, phone screen or availability request", () => {
    const screening = line("Screening");
    expect(screening).toMatch(/recruiter/i);
    expect(screening).toMatch(/phone|video/i);
    expect(screening).toMatch(/availability/i);
  });

  test("keeps Interview for the hiring manager or a technical round", () => {
    const interview = line("Interview");
    expect(interview).toMatch(/hiring manager/i);
    expect(interview).toMatch(/technical/i);
    expect(interview).not.toMatch(/availability/i);
  });

  test("files an in-house recruiter's personal cold outreach under Screening, not as a blast to ignore", () => {
    expect(line("Screening")).toMatch(/in-house/i);
    expect(CLASSIFIER_SYSTEM_PROMPT).not.toContain("recruiter prospecting where he has NOT already applied");
    // Mass mail to many people is still not his process.
    expect(CLASSIFIER_SYSTEM_PROMPT).toMatch(/sent to many people|mass/i);
  });
});

describe("CLASSIFIER_SYSTEM_PROMPT: Staffing/recruiter", () => {
  const line = (label: string) => CLASSIFIER_SYSTEM_PROMPT.split("\n").find((l) => l.startsWith(`- ${label}:`)) ?? "";

  test("defines Staffing/recruiter as an agency recruiter sending a job description and asking him to apply", () => {
    const staffing = line("Staffing/recruiter");
    expect(staffing).toMatch(/agency/i);
    expect(staffing).toMatch(/job description|position details/i);
    expect(staffing).toMatch(/apply/i);
  });

  test("stores such mail instead of dropping it as an invitation to apply", () => {
    // The NO list drops "invitations to apply"; the agency case has to be carved out of it.
    expect(CLASSIFIER_SYSTEM_PROMPT).toMatch(/staffing agency[^.]*personally[^.]*Staffing\/recruiter/i);
  });

  test("makes the agency the employer and keeps the client in the evidence", () => {
    const employerRule = CLASSIFIER_SYSTEM_PROMPT.split("\n").find((l) => l.startsWith('- "employer":')) ?? "";
    expect(employerRule).toMatch(/agency/i);
    expect(employerRule).toMatch(/evidence/i);
    expect(CLASSIFIER_SYSTEM_PROMPT).not.toContain("the client if named, otherwise null");
  });
});

describe("parseVerdict: employer, role and round extraction", () => {
  const raw = (extra: Record<string, unknown>) =>
    JSON.stringify({ isJob: true, category: "Interview", evidence: "round 2", ...extra });

  test("reads employer, role and round", () => {
    const v = parseVerdict(raw({ employer: "Cotiviti", role: "Intern - Gen AI Research Engineer", round: 2 }), "m");
    expect(v).toMatchObject({ isJob: true, employer: "Cotiviti", role: "Intern - Gen AI Research Engineer", round: 2 });
  });

  test("reads the hiring platform as via and treats blanks as not stated", () => {
    expect(parseVerdict(raw({ employer: "Cotiviti", via: "iCIMS" }), "m")).toMatchObject({ employer: "Cotiviti", via: "iCIMS" });
    expect(parseVerdict(raw({ via: "N/A" }), "m")).toMatchObject({ via: null });
    expect(parseVerdict(raw({}), "m")).toMatchObject({ via: null });
  });

  test("keeps via when max_tokens cuts the evidence short", () => {
    const cut = '{"isJob": true, "category": "Interview", "employer": "Cotiviti", "via": "Greenhouse", "role": "Data Scientist I", "round": 1, "evidence": "Your inter';
    expect(parseVerdict(cut, "m")).toMatchObject({ employer: "Cotiviti", via: "Greenhouse" });
  });

  test("the prompt asks for the hiring platform as via", () => {
    expect(CLASSIFIER_SYSTEM_PROMPT).toMatch(/"via"/);
  });

  test.each([null, "", "null", "N/A", "unknown", "  "])("treats %j as no employer / role rather than a name", (value) => {
    const v = parseVerdict(raw({ employer: value, role: value }), "m");
    expect(v).toMatchObject({ isJob: true, employer: null, role: null });
  });

  test("an ATS name returned as the employer is discarded, never trusted", () => {
    for (const ats of ["iCIMS", "Greenhouse", "LinkedIn", "Workday", "Hiring Team"]) {
      expect(parseVerdict(raw({ employer: ats }), "m")).toMatchObject({ employer: null });
    }
  });

  test("missing fields from an older-style answer become null, not a throw", () => {
    expect(parseVerdict(raw({}), "m")).toMatchObject({ employer: null, via: null, role: null, round: null });
  });

  test("a round that is not a small positive integer becomes null", () => {
    for (const round of [0, -1, 2.5, "two", 99, null]) {
      expect(parseVerdict(raw({ round }), "m")).toMatchObject({ round: null });
    }
  });

  test("keeps employer and role when max_tokens cuts the evidence short", () => {
    const cut = '{"isJob": true, "category": "Interview", "employer": "Cotiviti", "role": "Data Scientist I", "round": 1, "evidence": "Your inter';
    expect(parseVerdict(cut, "m")).toMatchObject({ category: "Interview", employer: "Cotiviti", role: "Data Scientist I", round: 1 });
  });

  test("caps absurdly long role strings", () => {
    const v = parseVerdict(raw({ role: "x".repeat(900) }), "m");
    if (!v.isJob) throw new Error("expected job verdict");
    expect(v.role!.length).toBeLessThanOrEqual(200);
  });
});

describe("CLASSIFIER_SYSTEM_PROMPT: extraction rules", () => {
  test("defines the employer as the real company, never the ATS or recruiter's domain", () => {
    expect(CLASSIFIER_SYSTEM_PROMPT).toMatch(/real employer/i);
    expect(CLASSIFIER_SYSTEM_PROMPT).toMatch(/never[\s\S]*(iCIMS|ATS)/i);
  });

  test("tells the model to answer null rather than guess an employer or role", () => {
    expect(CLASSIFIER_SYSTEM_PROMPT).toMatch(/null/);
  });

  test("keeps the term or cohort in the role (Spring 2027)", () => {
    expect(CLASSIFIER_SYSTEM_PROMPT).toMatch(/Spring 2027/);
  });

  test("tells the model to ignore forwarded blocks and mail written to someone else (scenarios 19, 40)", () => {
    expect(CLASSIFIER_SYSTEM_PROMPT).toMatch(/Forwarded message/i);
    expect(CLASSIFIER_SYSTEM_PROMPT).toMatch(/written to someone else/i);
  });

  test("asks for employer and role before evidence, so a truncated answer keeps them", () => {
    const at = (s: string) => CLASSIFIER_SYSTEM_PROMPT.lastIndexOf(s);
    expect(at('"employer"')).toBeLessThan(at('"evidence"'));
  });
});
