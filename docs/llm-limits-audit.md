# LLM limits audit (ticket T9)

Scope: the classifier chain in `src/lib/llm/models.ts` (primary `google/gemini-2.5-flash-lite`, fallback `openai/gpt-5-nano`, both via OpenRouter) against the new 60-day window and the extra extraction fields.

Method: read the code and its recorded measurements. **Nothing here was measured against your live OpenRouter account** (this environment has no keys). Call counts are estimates built from figures already in the code comments (about 21 stored emails/day, worst day 56, roughly half killed by the free prefilter, about 1,700 calls for a 45-day window).

## What changed in call volume

| Change | Effect on calls |
|---|---|
| Employer, role, round extracted | **None.** They ride on the existing classification call. |
| Prompt +~250 input tokens, answer +~45 output tokens | Cost per call about $0.00017 → about $0.00021. |
| `CLASSIFIER_MAX_TOKENS` 220 → 300 | Needed: the answer is longer. The fallback model runs at reasoning effort "minimal" (0 reasoning tokens), so the larger answer still fits. |
| Live sync window 14 → 60 days | No change in steady-state calls: only unseen mail is classified. |
| `scripts/link-history.mts` re-extraction | One call per stored email in the window that has no extraction yet: **up to about 2,356 calls, once.** |

## Limits, and whether they cause errors

| Limit | Value | Verdict |
|---|---|---|
| Per-minute pacing, per model | 360/min (self-imposed). Only 6 requests are ever in flight. | Safe. OpenRouter publishes no per-request cap for paid models; a real 429 is retried twice (honouring Retry-After up to 5s), then falls back to the other model. |
| Per-day cap, per model | **1,000** (`LLM_CALLS_PER_DAY`, max 20,000). A cost control, not a provider limit. Primary and fallback each get 1,000, so 2,000/day in total. | **Will bite one-off jobs.** First 60-day backfill ≈ 1,700–2,300 calls plus ≈ 2,356 for re-extraction. Over the cap the code does not error: it stops cleanly (`hitLlmBudget` / "stopped early"), nothing is banked wrongly, and it resumes the next day. |
| Per-run cap (live sync) | 80 calls, 12s work budget | Safe. A backlog drains over later ticks. |
| Fallback quality | Calls past the primary's 1,000 go to `gpt-5-nano` | Works, but extraction quality may differ from the primary. Keep the primary's cap high for the one-off jobs so a single model does all of it. |
| Credits / key problems (HTTP 401, 402, 403, 404) | classified `fatal` | Stops immediately, does **not** try the fallback (same key and credits), is never banked as "not job related", and alerts via Telegram. Correct. |
| Unparseable answer | `unusable`, one retry on the other model | Never banked as a skip. Correct. |

## Recommended settings

- **Production (Vercel):** leave `LLM_CALLS_PER_DAY` unset (1,000). Steady state is about 85 calls/day (worst day about 450).
- **One-off backfill and `link:history` (local `.env` only):** `LLM_CALLS_PER_DAY=3000`. About $0.50 of exposure in total at about $0.00021 a call. Remove it afterwards: forgetting to unset it is what turns a temporary allowance into a permanent bill (see the note in `models.ts`).
- Set `SYNC_LOOKBACK_DAYS` on Vercel only if you want something other than 60; an old value there silently overrides the new default.

## Real risks found while auditing (and fixed)

1. **Linking inside the sync could overrun the serverless budget.** Each linked email costs several round trips on the pooled connection; a post-outage burst of 80 emails could add tens of seconds. Fixed: at most 10 emails linked per run, never when the time budget is spent, leftovers stay pending for the next tick.
2. **Layout and page queries running concurrently on one connection.** Next renders them in parallel and the pooler stalls pipelined queries (documented in `api/sync/route.ts`). Fixed: the layout does no database work; each page loads its tab counts sequentially.
3. **Live sync only lists the newest 500 matching messages** (`MAX_LISTED_MESSAGES`, no paging). Fine for steady state, but a 60-day catch-up must go through `npm run backfill` (which pages), not the cron route.

## Still to verify with real keys

- Run `npm run eval:extraction -- --sample=100` and record employer/role accuracy. If role accuracy is poor, the Linker asks more often (safe) rather than merging wrongly.
- Watch the first real `link:history` run for `stopped early` messages and for the share of emails that land in Review.
