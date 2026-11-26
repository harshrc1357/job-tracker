import { describe, expect, test } from "vitest";
import { reviewChoices } from "./reviewChoices";

const at = (id: number, daysAgo: number) => ({ id, lastActivityAt: new Date(Date.UTC(2026, 9, 13 - daysAgo)) });

describe("reviewChoices: a Review item lists its choices and highlights one only when it is sound", () => {
  test("a scored candidate list recommends the best match", () => {
    const r = reviewChoices([{ applicationId: 2, score: 0.55 }, { applicationId: 1, score: 0.6 }], [at(1, 3), at(2, 1)]);
    expect(r).toEqual({ attach: [1, 2], recommended: 1 });
  });

  // Scenario 3: the email names no role, or the Applications name none. Nothing separates the
  // candidates, so a highlight would be a guess, and a rejection tapped on the wrong one closes it.
  test("candidates that all score 0 get no highlight, but are still listed, most recent first", () => {
    const r = reviewChoices([{ applicationId: 1, score: 0 }, { applicationId: 2, score: 0 }], [at(1, 9), at(2, 2)]);
    expect(r.recommended).toBeNull();
    expect(r.attach).toEqual([2, 1]);
  });

  test("one candidate with a real score is still highlighted, even if a weaker one scores 0", () => {
    const r = reviewChoices([{ applicationId: 1, score: 0 }, { applicationId: 2, score: 0.6 }], [at(1, 2), at(2, 9)]);
    expect(r.recommended).toBe(2);
  });

  test("an item with no candidates still lists the open applications at that employer", () => {
    const r = reviewChoices([], [at(1, 9), at(2, 2)]);
    expect(r.attach).toEqual([2, 1]);
  });

  test("with no candidates the recommendation is a new application, never an existing one", () => {
    expect(reviewChoices([], [at(1, 9)]).recommended).toBe("new");
    expect(reviewChoices([], []).recommended).toBe("new");
  });

  // Scenario 2: the email does not name the company (Indeed, LinkedIn, Workday). "New application"
  // would be named after the sender or platform, so no button is the right one to highlight.
  test("an unknown employer gets no highlight", () => {
    expect(reviewChoices([], [], false).recommended).toBeNull();
  });

  test("an application is never listed twice", () => {
    const r = reviewChoices([{ applicationId: 1, score: 0.6 }], [at(1, 3), at(2, 1)]);
    expect(r.attach).toEqual([1, 2]);
  });
});
