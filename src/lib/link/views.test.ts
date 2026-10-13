import { describe, expect, test } from "vitest";
import { applicationCounts, filterApplications, isGhosted, pipelineApps, pipelineCounts, type AppRow } from "./views";

const NOW = new Date("2026-10-13T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

let id = 0;
const row = (over: Partial<AppRow> = {}): AppRow => ({
  id: ++id,
  employer: "Cotiviti",
  role: "Data Scientist",
  stage: "Applied",
  rejected: false,
  interviewRound: 0,
  flags: [],
  appliedAt: daysAgo(10),
  lastActivityAt: daysAgo(10),
  emailCount: 1,
  needsReview: false,
  ...over,
});

describe("Pipeline: a card only once it moves past Applied", () => {
  const apps = [
    row({ stage: "Applied" }),
    row({ stage: "Applied", rejected: true }),
    row({ stage: "Assessment" }),
    row({ stage: "Interview", interviewRound: 2 }),
    row({ stage: "Interview", rejected: true }),
    row({ stage: "Offer" }),
  ];

  test("Active holds progressed, open applications only", () => {
    expect(pipelineApps(apps, "active").map((a) => a.stage).sort()).toEqual(["Assessment", "Interview", "Offer"]);
  });

  test("Applied-only applications never appear on the Pipeline, open or rejected", () => {
    for (const f of ["active", "interview", "assessment", "screening", "offer", "needs-action", "closed"] as const) {
      expect(pipelineApps(apps, f).every((a) => a.stage !== "Applied")).toBe(true);
    }
  });

  test("Closed holds progressed applications that were rejected", () => {
    expect(pipelineApps(apps, "closed")).toHaveLength(1);
    expect(pipelineApps(apps, "closed")[0].stage).toBe("Interview");
  });

  test("stage filters only show open applications at that stage", () => {
    expect(pipelineApps(apps, "interview")).toHaveLength(1);
    expect(pipelineApps(apps, "assessment")).toHaveLength(1);
    expect(pipelineApps(apps, "screening")).toHaveLength(0);
  });

  test("Needs action holds open progressed applications that are flagged or waiting on review", () => {
    const flagged = row({ stage: "Interview", flags: ["reopened"] });
    const waiting = row({ stage: "Assessment", needsReview: true });
    const quiet = row({ stage: "Interview" });
    expect(pipelineApps([flagged, waiting, quiet], "needs-action").map((a) => a.id).sort()).toEqual([flagged.id, waiting.id].sort());
  });

  test("counts match the lists, and newest activity comes first", () => {
    const counts = pipelineCounts(apps);
    expect(counts.active).toBe(3);
    expect(counts.closed).toBe(1);
    const a = row({ stage: "Interview", lastActivityAt: daysAgo(5) });
    const b = row({ stage: "Interview", lastActivityAt: daysAgo(1) });
    expect(pipelineApps([a, b], "active").map((x) => x.id)).toEqual([b.id, a.id]);
  });

  test("two roles at one employer stay two entries", () => {
    const pair = [row({ role: "Gen AI Intern", stage: "Interview" }), row({ role: "Data Scientist I", stage: "Screening", rejected: true })];
    expect(pipelineApps(pair, "active")).toHaveLength(1);
    expect(pipelineApps(pair, "closed")).toHaveLength(1);
  });
});

describe("Applications table and Ghosted 30d+", () => {
  test("ghosted means Applied-only, still open, and silent for 30 days or more", () => {
    expect(isGhosted(row({ lastActivityAt: daysAgo(30) }), NOW)).toBe(true);
    expect(isGhosted(row({ lastActivityAt: daysAgo(29) }), NOW)).toBe(false);
    expect(isGhosted(row({ lastActivityAt: daysAgo(90), stage: "Interview" }), NOW)).toBe(false);
    expect(isGhosted(row({ lastActivityAt: daysAgo(90), rejected: true }), NOW)).toBe(false);
  });

  const apps = [
    row({ stage: "Applied", lastActivityAt: daysAgo(40) }),
    row({ stage: "Applied", lastActivityAt: daysAgo(2) }),
    row({ stage: "Interview" }),
    row({ stage: "Applied", rejected: true }),
  ];

  test("filters: all, applied only, progressed, rejected, ghosted", () => {
    expect(filterApplications(apps, "all", NOW)).toHaveLength(4);
    // Stage-based, as in the mockup (201 + 83 = 284): a rejected Applied-only application
    // is both Applied-only and Rejected.
    expect(filterApplications(apps, "applied-only", NOW)).toHaveLength(3);
    expect(filterApplications(apps, "progressed", NOW)).toHaveLength(1);
    expect(filterApplications(apps, "rejected", NOW)).toHaveLength(1);
    expect(filterApplications(apps, "ghosted", NOW)).toHaveLength(1);
  });

  test("a company filter is case-insensitive and exact on the employer", () => {
    const mixed = [row({ employer: "Snowflake" }), row({ employer: "Snowflake Computing" }), row({ employer: "Cotiviti" })];
    expect(filterApplications(mixed, "all", NOW, "snowflake")).toHaveLength(1);
  });

  test("nothing is dropped: counts add up and the list is sorted by last activity", () => {
    const counts = applicationCounts(apps, NOW);
    expect(counts.all).toBe(4);
    expect(counts["applied-only"] + counts.progressed).toBe(counts.all);
    const sorted = filterApplications(apps, "all", NOW);
    const times = sorted.map((a) => a.lastActivityAt.getTime());
    expect(times).toEqual([...times].sort((x, y) => y - x));
  });
});
