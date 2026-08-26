// Thin wrapper around Groq's OpenAI-compatible chat completions endpoint.
// Free tier: console.groq.com. Model choice kept in one place so it's easy to swap
// for Gemini or another free provider later without touching classify.ts/extractDueDate.ts.

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.1-8b-instant";

export async function groqComplete(
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 20
): Promise<string | null> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error("[groq] GROQ_API_KEY not set, skipping LLM call");
    return null;
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
    console.error("[groq] request failed", res.status, await res.text());
    return null;
  }

  const data = await res.json();
  const content: string | undefined = data?.choices?.[0]?.message?.content;
  return content?.trim() ?? null;
}
