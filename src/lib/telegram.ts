// Every character Telegram's MarkdownV2 parser treats as special. Any of these
// arriving unescaped inside a subject line makes the API reject the entire message
// with a 400, so the notification silently never lands. Backslash is escaped first,
// otherwise the escapes we add would themselves get escaped.
const MARKDOWN_V2_SPECIALS = "_*[]()~`>#+-=|{}.!";

export function escapeMarkdownV2(text: string): string {
  let escaped = text.replace(/\\/g, "\\\\");
  for (const char of MARKDOWN_V2_SPECIALS) {
    escaped = escaped.split(char).join(`\\${char}`);
  }
  return escaped;
}

// Throws on failure rather than logging and returning. Callers decide what a failed
// notification means: sync/route.ts uses it to avoid burning a reminder count on a
// nudge that never arrived, and to surface the failure in the run's error list.
export async function sendTelegramMessage(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    throw new Error("TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not set");
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "MarkdownV2",
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram send failed: ${res.status} ${body}`);
  }
}

// Best-effort variant for paths where a failed notification must not fail the caller,
// e.g. the alert that reports a sync failure — there is nowhere left to escalate to.
export async function trySendTelegramMessage(text: string): Promise<void> {
  try {
    await sendTelegramMessage(text);
  } catch (err) {
    console.error("[telegram] send failed", err);
  }
}
