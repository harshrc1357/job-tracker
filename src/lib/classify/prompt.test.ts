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
    expect(verdict).toEqual({ isJob: true, category: "Offer", evidence: "pleased to offer" });
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
    expect(verdict).toEqual({ isJob: true, category: "Applied", evidence: "" });
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
    // Arrange: a hallucinated category ("Screening") must not be written to a column
    // the dashboard filters on.
    expect(() =>
      parseVerdict('{"isJob": true, "category": "Screening", "evidence": "x"}', "test-model")
    ).toThrow(/unknown category/);
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
      "Verification > Rejection > Offer > Interview > Assessment > Reminder > Applied"
    );
  });
});
