import { describe, expect, test } from "vitest";
import { scoreExtraction, type EvalRow } from "./extractionEval";

const row = (over: Partial<EvalRow> = {}): EvalRow => ({
  id: 1,
  predicted: { employer: "Cotiviti", role: "Data Scientist I", round: null },
  expected: { employer: "Cotiviti", role: "Data Scientist I", round: null },
  ...over,
});

describe("scoreExtraction", () => {
  test("a perfect run scores 100% on every field", () => {
    expect(scoreExtraction([row(), row({ id: 2 })])).toMatchObject({ labelled: 2, employer: 1, role: 1, round: 1 });
  });

  test("employer matches through aliases and corporate suffixes", () => {
    const r = row({ predicted: { employer: "HPE", role: null, round: null }, expected: { employer: "Hewlett Packard Enterprise, Inc.", role: null, round: null } });
    expect(scoreExtraction([r]).employer).toBe(1);
  });

  test("role matches on meaning, not exact text", () => {
    const r = row({ predicted: { employer: "Cotiviti", role: "Data Scientist 1", round: null }, expected: { employer: "Cotiviti", role: "Data Scientist I", round: null } });
    expect(scoreExtraction([r]).role).toBe(1);
  });

  test("a wrong employer is counted and listed for review", () => {
    const r = row({ id: 7, predicted: { employer: "icims", role: null, round: null }, expected: { employer: "Cotiviti", role: null, round: null } });
    const score = scoreExtraction([r]);
    expect(score.employer).toBe(0);
    expect(score.wrong.map((w) => [w.id, w.field])).toContainEqual([7, "employer"]);
  });

  test("saying null when the answer is null is correct, saying null when it is not is wrong", () => {
    const nullBoth = row({ predicted: { employer: "Cotiviti", role: null, round: null }, expected: { employer: "Cotiviti", role: null, round: null } });
    const missed = row({ id: 2, predicted: { employer: "Cotiviti", role: null, round: null }, expected: { employer: "Cotiviti", role: "Data Scientist", round: null } });
    expect(scoreExtraction([nullBoth]).role).toBe(1);
    expect(scoreExtraction([missed]).role).toBe(0);
  });

  test("a hallucinated role where none exists is wrong, and reported separately as the costlier error", () => {
    const r = row({ predicted: { employer: "Cotiviti", role: "Made Up Role", round: null }, expected: { employer: "Cotiviti", role: null, round: null } });
    const score = scoreExtraction([r]);
    expect(score.role).toBe(0);
    expect(score.invented).toBe(1);
  });

  test("rows with no hand label yet are not scored", () => {
    const unlabelled = row({ id: 3, expected: null });
    expect(scoreExtraction([row(), unlabelled])).toMatchObject({ labelled: 1, unlabelled: 1 });
  });

  test("an empty set does not divide by zero", () => {
    expect(scoreExtraction([])).toMatchObject({ labelled: 0, employer: 0, role: 0, round: 0 });
  });
});
