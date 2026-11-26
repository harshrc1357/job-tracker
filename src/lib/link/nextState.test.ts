import { describe, expect, test } from "vitest";
import { nextState } from "./nextState";
import type { ApplicationState } from "./types";

const state = (over: Partial<ApplicationState> = {}): ApplicationState => ({
  stage: "Applied",
  round: 0,
  status: "open",
  flags: [],
  ...over,
});

describe("nextState: stage only moves forward (scenarios 22, 23, 24)", () => {
  test.each([
    ["Applied", "screening", "Screening"],
    ["Screening", "assessment", "Assessment"],
    ["Assessment", "interview", "Interview"],
    ["Interview", "offer", "Offer"],
  ] as const)("%s + %s mail becomes %s", (stage, kind, expected) => {
    expect(nextState(state({ stage }), { kind, round: null }).stage).toBe(expected);
  });

  test("an assessment after an interview does not demote the application", () => {
    expect(nextState(state({ stage: "Interview", round: 1 }), { kind: "assessment", round: null }).stage).toBe("Interview");
  });

  test("an Applied confirmation arriving late does not demote anything", () => {
    expect(nextState(state({ stage: "Interview", round: 2 }), { kind: "applied", round: null }).stage).toBe("Interview");
  });

  test("a reminder never changes the stage", () => {
    expect(nextState(state({ stage: "Assessment" }), { kind: "reminder", round: null }).stage).toBe("Assessment");
  });

  test("a recruiter outreach never changes the stage", () => {
    expect(nextState(state({ stage: "Screening" }), { kind: "outreach", round: null }).stage).toBe("Screening");
  });

  test("a staffing agency's job description changes neither the stage nor a rejection", () => {
    expect(nextState(state({ stage: "Interview", round: 1 }), { kind: "staffing", round: null })).toMatchObject({ stage: "Interview", round: 1, status: "open" });
    expect(nextState(state({ stage: "Screening", status: "rejected" }), { kind: "staffing", round: null })).toMatchObject({ stage: "Screening", status: "rejected", flags: [] });
  });
});

describe("nextState: interview rounds (scenario 23)", () => {
  test("the first interview mail with no round number is round 1", () => {
    expect(nextState(state({ stage: "Screening" }), { kind: "interview", round: null })).toMatchObject({ stage: "Interview", round: 1 });
  });

  test("a stated round is recorded", () => {
    expect(nextState(state({ stage: "Interview", round: 1 }), { kind: "interview", round: 2 }).round).toBe(2);
  });

  test("a lower round arriving late does not lower the round", () => {
    expect(nextState(state({ stage: "Interview", round: 2 }), { kind: "interview", round: 1 }).round).toBe(2);
  });

  test("a further interview mail with no number keeps the current round", () => {
    expect(nextState(state({ stage: "Interview", round: 2 }), { kind: "interview", round: null }).round).toBe(2);
  });
});

describe("nextState: rejection is terminal unless reopened (scenarios 25, 30)", () => {
  test("a rejection closes the application and keeps the stage it reached", () => {
    expect(nextState(state({ stage: "Interview", round: 1 }), { kind: "rejection", round: null })).toMatchObject({ status: "rejected", stage: "Interview" });
  });

  test("a rejection after an offer is flagged as rescinded", () => {
    expect(nextState(state({ stage: "Offer" }), { kind: "rejection", round: null }).flags).toContain("offer-rescinded");
  });

  test("progress mail on a rejected application reopens it with a flag", () => {
    const next = nextState(state({ stage: "Interview", status: "rejected" }), { kind: "interview", round: 2 });
    expect(next).toMatchObject({ status: "open", round: 2 });
    expect(next.flags).toContain("reopened");
  });

  test("a duplicate Applied email does not reopen a rejected application", () => {
    expect(nextState(state({ stage: "Screening", status: "rejected" }), { kind: "applied", round: null }).status).toBe("rejected");
  });

  test("a second rejection leaves it rejected without a flag", () => {
    const next = nextState(state({ stage: "Screening", status: "rejected" }), { kind: "rejection", round: null });
    expect(next).toMatchObject({ status: "rejected", flags: [] });
  });

  test("it never mutates the state it was given", () => {
    const before = state({ stage: "Applied" });
    nextState(before, { kind: "interview", round: 1 });
    expect(before).toEqual(state());
  });
});
