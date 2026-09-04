// Thin wrapper around Groq's OpenAI-compatible chat completions endpoint.
// Free tier: console.groq.com. Model choice kept in one place so it's easy to swap
// for Gemini or another free provider later without touching classify.ts/extractDueDate.ts.

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
// llama-3.1-8b-instant was fully decommissioned from Groq's catalog (confirmed via
// GET /v1/models on 2026-09-04 — every call was silently 404ing, which groqComplete
// swallows into a null return, which classify.ts/extractDueDate.ts read as "no
// result" rather than "call failed"). groq/compound-mini is a direct drop-in: plain
// short answers in `content` with no reasoning-token wrapper, unlike the openai/gpt-oss-*
// and qwen/qwen3.* models now on the account, which need reasoning_effort tuning or
// leak <think> tags into content.
const MODEL = "groq/compound-mini";

// Throws on config/request failure instead of returning null. The old behavior
// (return null → callers treat "call failed" the same as "model said Skip") is what
// let a fully decommissioned model 404 silently for over a week: every non-keyword
// email got treated as "not job-related" with zero visibility. Callers now either
// let this propagate (classifyEmail/extractDueDate) or catch it per-message in
// sync/route.ts, so a Groq outage shows up in result.errors and the message stays
// unrecorded for retry next run, instead of being permanently misclassified.
export async function groqComplete(
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 20
): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY not set");
  }

  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Groq request failed: ${res.status} ${body}`);
  }

  const data = await res.json();
  const content: string | undefined = data?.choices?.[0]?.message?.content;
  return content?.trim() ?? "";
}
