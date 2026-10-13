import { describe, expect, test } from "vitest";
import { applicationCounts, daysQuiet, filterApplications, isGhosted, pipelineApps, pipelineCounts, type AppRow } from "./views";

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
  test("ghosted means still open and silent for 30 days or more", () => {
    expect(isGhosted(row({ lastActivityAt: daysAgo(30) }), NOW)).toBe(true);
    expect(isGhosted(row({ lastActivityAt: daysAgo(29) }), NOW)).toBe(false);
    expect(isGhosted(row({ lastActivityAt: daysAgo(90), rejected: true }), NOW)).toBe(false);
  });

  test.each(["Applied", "Screening", "Assessment", "Interview", "Offer"] as const)(
    "an open %s application that went quiet is ghosted, whatever stage it reached",
    (stage) => {
      expect(isGhosted(row({ stage, lastActivityAt: daysAgo(31) }), NOW)).toBe(true);
      expect(isGhosted(row({ stage, lastActivityAt: daysAgo(5) }), NOW)).toBe(false);
    },
  );

  test("a rejected application is never ghosted, at any stage", () => {
    for (const stage of ["Applied", "Interview", "Offer"] as const) {
      expect(isGhosted(row({ stage, rejected: true, lastActivityAt: daysAgo(200) }), NOW)).toBe(false);
    }
  });

  test("daysQuiet counts whole days since the last email, for the Ghosted badge", () => {
    expect(daysQuiet(row({ lastActivityAt: daysAgo(45) }), NOW)).toBe(45);
    expect(daysQuiet(row({ lastActivityAt: new Date(NOW.getTime() - 45.9 * 86_400_000) }), NOW)).toBe(45);
    expect(daysQuiet(row({ lastActivityAt: NOW }), NOW)).toBe(0);
  });

  test("a new email clears it: ghosted is read from the last activity, never stored", () => {
    const quiet = row({ stage: "Interview", lastActivityAt: daysAgo(45) });
    expect(isGhosted(quiet, NOW)).toBe(true);
    expect(isGhosted({ ...quiet, lastActivityAt: NOW }, NOW)).toBe(false);
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

  test("the Ghosted filter and its count include applications that got past Applied", () => {
    const quiet = row({ stage: "Interview", lastActivityAt: daysAgo(60) });
    const live = row({ stage: "Interview", lastActivityAt: daysAgo(2) });
    const mixed = [...apps, quiet, live];
    expect(filterApplications(mixed, "ghosted", NOW).map((a) => a.id).sort()).toEqual(
      [apps[0].id, quiet.id].sort(),
    );
    expect(applicationCounts(mixed, NOW).ghosted).toBe(2);
  });

  test("a ghosted application stays on the Pipeline, where the card shows it", () => {
    const quiet = row({ stage: "Assessment", lastActivityAt: daysAgo(60) });
    expect(pipelineApps([quiet], "active").map((a) => a.id)).toEqual([quiet.id]);
  });

  test("an employer filter is case-insensitive and exact on the employer", () => {
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
