// Pure view logic for the Pipeline and Applications pages. No React, no database, so the
// rules the owner cares about ("Applied-only never clutters Pipeline", "Ghosted means 30
// days") are tested directly.

import type { Stage } from "./types";

export type AppRow = {
  id: number;
  employer: string;
  role: string | null;
  stage: Stage;
  rejected: boolean;
  interviewRound: number;
  flags: string[];
  appliedAt: Date | null;
  lastActivityAt: Date;
  emailCount: number;
  // An email of this application is waiting in the Review queue.
  needsReview: boolean;
};

export const GHOSTED_AFTER_DAYS = 30;
const DAY_MS = 86_400_000;

export const PIPELINE_FILTERS = ["active", "interview", "assessment", "screening", "offer", "needs-action", "closed"] as const;
export type PipelineFilter = (typeof PIPELINE_FILTERS)[number];

export const APPLICATION_FILTERS = ["all", "applied-only", "progressed", "rejected", "ghosted"] as const;
export type ApplicationFilter = (typeof APPLICATION_FILTERS)[number];

export const isProgressed = (a: AppRow) => a.stage !== "Applied";

export function isGhosted(a: AppRow, now: Date): boolean {
  return !isProgressed(a) && !a.rejected && now.getTime() - a.lastActivityAt.getTime() >= GHOSTED_AFTER_DAYS * DAY_MS;
}

const byRecent = (a: AppRow, b: AppRow) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime();

export function pipelineApps(apps: readonly AppRow[], filter: PipelineFilter): AppRow[] {
  // Applied-only never reaches the Pipeline, whatever the filter.
  const progressed = apps.filter(isProgressed);
  const open = progressed.filter((a) => !a.rejected);
  const pick: Record<PipelineFilter, AppRow[]> = {
    active: open,
    interview: open.filter((a) => a.stage === "Interview"),
    assessment: open.filter((a) => a.stage === "Assessment"),
    screening: open.filter((a) => a.stage === "Screening"),
    offer: open.filter((a) => a.stage === "Offer"),
    "needs-action": open.filter((a) => a.flags.length > 0 || a.needsReview),
    closed: progressed.filter((a) => a.rejected),
  };
  return [...pick[filter]].sort(byRecent);
}

export function pipelineCounts(apps: readonly AppRow[]): Record<PipelineFilter, number> {
  return Object.fromEntries(PIPELINE_FILTERS.map((f) => [f, pipelineApps(apps, f).length])) as Record<PipelineFilter, number>;
}

export function filterApplications(apps: readonly AppRow[], filter: ApplicationFilter, now: Date, company?: string): AppRow[] {
  const wanted = company?.trim().toLowerCase();
  const pick: Record<ApplicationFilter, (a: AppRow) => boolean> = {
    all: () => true,
    "applied-only": (a) => !isProgressed(a),
    progressed: isProgressed,
    rejected: (a) => a.rejected,
    ghosted: (a) => isGhosted(a, now),
  };
  return apps
    .filter((a) => pick[filter](a) && (!wanted || a.employer.toLowerCase() === wanted))
    .sort(byRecent);
}

export function applicationCounts(apps: readonly AppRow[], now: Date): Record<ApplicationFilter, number> {
  return Object.fromEntries(APPLICATION_FILTERS.map((f) => [f, filterApplications(apps, f, now).length])) as Record<ApplicationFilter, number>;
}
