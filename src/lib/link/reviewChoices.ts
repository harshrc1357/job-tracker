import type { Candidate } from "./types";

type OpenAtEmployer = { id: number; lastActivityAt: Date };

export type ReviewChoices = {
  // Applications to offer as "attach to this", best first.
  attach: number[];
  // The one to highlight: an application id, or "new". null when nothing separates the
  // choices, so the owner picks. A highlight is a suggestion, never an action.
  recommended: number | "new" | null;
};

// What the Review page offers for one item. The linker's own candidates come first. When
// it named none (it could not match a role), the open applications at the same employer
// are offered instead, so the owner can still pick an existing one.
export function reviewChoices(
  candidates: readonly Candidate[],
  openAtEmployer: readonly OpenAtEmployer[],
  // false when the email does not name a usable employer. A new Application would then be
  // named after the sender or platform, so "New application" is not a sound suggestion.
  employerKnown = true,
): ReviewChoices {
  const recency = new Map(openAtEmployer.map((a) => [a.id, a.lastActivityAt.getTime()]));
  const byRecency = (a: number, b: number) => (recency.get(b) ?? 0) - (recency.get(a) ?? 0);

  const scored = [...candidates].sort((x, y) => y.score - x.score || byRecency(x.applicationId, y.applicationId));
  const listed = new Set(scored.map((c) => c.applicationId));
  const others = openAtEmployer.map((a) => a.id).filter((id) => !listed.has(id)).sort(byRecency);
  const attach = [...scored.map((c) => c.applicationId), ...others];

  if (scored.length === 0) return { attach, recommended: employerKnown ? "new" : null };
  // Every candidate scoring 0 means there was no role to compare: the first is only the newest.
  return { attach, recommended: scored[0].score > 0 ? scored[0].applicationId : null };
}
