import type { Candidate } from "./types";

type OpenAtEmployer = { id: number; lastActivityAt: Date };

export type ReviewChoices = {
  // Applications to offer as "attach to this", best first.
  attach: number[];
  // The one to highlight: an application id, or "new". Always present, so no Review item
  // is left without a recommended answer. A highlight is a suggestion, never an action.
  recommended: number | "new";
};

// What the Review page offers for one item. The linker's own candidates come first. When
// it named none (it could not match a role), the open applications at the same employer
// are offered instead, so the owner can still pick an existing one.
export function reviewChoices(candidates: readonly Candidate[], openAtEmployer: readonly OpenAtEmployer[]): ReviewChoices {
  const recency = new Map(openAtEmployer.map((a) => [a.id, a.lastActivityAt.getTime()]));
  const byRecency = (a: number, b: number) => (recency.get(b) ?? 0) - (recency.get(a) ?? 0);

  const scored = [...candidates].sort((x, y) => y.score - x.score || byRecency(x.applicationId, y.applicationId));
  const listed = new Set(scored.map((c) => c.applicationId));
  const others = openAtEmployer.map((a) => a.id).filter((id) => !listed.has(id)).sort(byRecency);
  const attach = [...scored.map((c) => c.applicationId), ...others];

  if (scored.length === 0) return { attach, recommended: "new" };
  return { attach, recommended: scored[0].applicationId };
}
