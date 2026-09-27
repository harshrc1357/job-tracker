// How far back the Gmail search reaches.
//
// Read from the environment rather than hardcoded, so a one-off backfill can widen the
// window without editing a constant and trusting someone to put it back. Forgetting to
// revert would multiply the per-run Gmail fetches and LLM spend indefinitely, which is
// exactly the kind of cost increase that hides until the bill arrives.

export const DEFAULT_LOOKBACK_DAYS = 14;
export const MAX_LOOKBACK_DAYS = 365;

export function lookbackDays(fallback: number = DEFAULT_LOOKBACK_DAYS): number {
  const raw = Number(process.env.SYNC_LOOKBACK_DAYS);
  if (!Number.isFinite(raw) || raw < 1) return fallback;
  return Math.min(Math.floor(raw), MAX_LOOKBACK_DAYS);
}
