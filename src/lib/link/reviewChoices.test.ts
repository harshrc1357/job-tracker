import { describe, expect, test } from "vitest";
import { reviewChoices } from "./reviewChoices";

const at = (id: number, daysAgo: number) => ({ id, lastActivityAt: new Date(Date.UTC(2026, 9, 13 - daysAgo)) });

describe("reviewChoices: every Review item offers a recommended one-tap answer", () => {
  test("a scored candidate list recommends the best match", () => {
    const r = reviewChoices([{ applicationId: 2, score: 0.55 }, { applicationId: 1, score: 0.6 }], [at(1, 3), at(2, 1)]);
    expect(r).toEqual({ attach: [1, 2], recommended: 1 });
  });

  test("roleless candidates all score 0, so the most recently active application is recommended", () => {
    const r = reviewChoices([{ applicationId: 1, score: 0 }, { applicationId: 2, score: 0 }], [at(1, 9), at(2, 2)]);
    expect(r.recommended).toBe(2);
    expect(r.attach).toEqual([2, 1]);
  });

  test("an item with no candidates still lists the open applications at that employer", () => {
    const r = reviewChoices([], [at(1, 9), at(2, 2)]);
    expect(r.attach).toEqual([2, 1]);
  });

  test("with no candidates the recommendation is a new application, never an existing one", () => {
    expect(reviewChoices([], [at(1, 9)]).recommended).toBe("new");
    expect(reviewChoices([], []).recommended).toBe("new");
  });

  test("an application is never listed twice", () => {
    const r = reviewChoices([{ applicationId: 1, score: 0.6 }], [at(1, 3), at(2, 1)]);
    expect(r.attach).toEqual([1, 2]);
  });
});
