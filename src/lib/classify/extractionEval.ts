// Scores the classifier's extracted employer / role / round against hand labels. Pure:
// the script that samples real emails and calls the model lives in scripts/, because
// those need the owner's database and API key. This part needs neither, so the scoring
// rules themselves are tested.

import { normalizeEmployer, roleSimilarity } from "@/lib/link/normalize";

export type Facts = { employer: string | null; role: string | null; round: number | null };
export type EvalRow = { id: number; predicted: Facts; expected: Facts | null };
export type Field = "employer" | "role" | "round";

export type Score = {
  labelled: number;
  unlabelled: number;
  // Fraction correct per field, 0..1.
  employer: number;
  role: number;
  round: number;
  // The costly error: a role invented where the email names none. A missing role makes
  // the Linker ask; an invented one can attach to the wrong application.
  invented: number;
  wrong: { id: number; field: Field; predicted: unknown; expected: unknown }[];
};

const ROLE_MATCH = 0.8;

function same(field: Field, predicted: Facts, expected: Facts): boolean {
  if (field === "employer") return normalizeEmployer(predicted.employer) === normalizeEmployer(expected.employer);
  if (field === "round") return predicted.round === expected.round;
  if (predicted.role === null || expected.role === null) return predicted.role === expected.role;
  return roleSimilarity(predicted.role, expected.role) >= ROLE_MATCH;
}

export function scoreExtraction(rows: readonly EvalRow[]): Score {
  const labelled = rows.filter((r): r is EvalRow & { expected: Facts } => r.expected !== null);
  const wrong: Score["wrong"] = [];
  const correct: Record<Field, number> = { employer: 0, role: 0, round: 0 };
  let invented = 0;

  for (const r of labelled) {
    for (const field of ["employer", "role", "round"] as const) {
      if (same(field, r.predicted, r.expected)) correct[field]++;
      else wrong.push({ id: r.id, field, predicted: r.predicted[field], expected: r.expected[field] });
    }
    if (r.expected.role === null && r.predicted.role !== null) invented++;
  }

  const rate = (n: number) => (labelled.length === 0 ? 0 : n / labelled.length);
  return {
    labelled: labelled.length,
    unlabelled: rows.length - labelled.length,
    employer: rate(correct.employer),
    role: rate(correct.role),
    round: rate(correct.round),
    invented,
    wrong,
  };
}
