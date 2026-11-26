// Cleaning for text that arrives from outside (an email, a model answer) before it is
// scanned or stored. Anyone can mail the owner, so every pattern here has to run in
// linear time: the first version used `<[^>]+>` and `<style[\s\S]*?</style>`, which take
// time proportional to the SQUARE of the input on a message full of '<' or '<style>'.
// 200 KB of '<' held one sync run for 14 seconds, and because the message was never
// recorded, every later run hung on it again.

// Most HTML the sync will read from one message. A job email is a few tens of KB; this
// leaves room for a heavy newsletter and cuts off anything built to be slow.
export const MAX_RAW_HTML_CHARS = 250_000;

// Most plain text kept per message. The classifier only reads the first 5,000
// characters, and the dashboard list ships this column for every row.
export const MAX_STORED_BODY_CHARS = 50_000;

// Postgres refuses NUL in a text column, and one refused row used to fail the whole
// batch stored with it. Tab, newline and carriage return are real text and stay.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function stripControlChars(text: string): string {
  return text.replace(CONTROL_CHARS, "");
}

export function capChars(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

// Removes `<tag ...>...</tag>` blocks. A lazy `[\s\S]*?` scans to the end of the input
// from every opening tag that has no closer, which is the quadratic case. Cutting the
// search at the LAST closer guarantees every opener before it finds one, so each scan
// ends at its own closer and the whole pass is linear. An opener after the last closer
// is left for the tag-stripping step.
function dropBlocks(html: string, tag: string): string {
  // ASCII-only lowercase keeps every index aligned with `html`; toLowerCase() changes the
  // length of a few letters.
  const lowered = html.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const closer = `</${tag}>`;
  const lastCloser = lowered.lastIndexOf(closer);
  if (lastCloser === -1) return html;

  const end = lastCloser + closer.length;
  const blocks = new RegExp(`<${tag}[\\s\\S]*?</${tag}>`, "gi");
  return html.slice(0, end).replace(blocks, "") + html.slice(end);
}

// Plain-text rendering of an HTML email, for the search column and the classifier when
// the sender sent no text/plain part. The HTML a person reads is the sanitized copy;
// this one only has to be readable and safe to scan.
export function stripHtml(html: string): string {
  const withoutBlocks = dropBlocks(dropBlocks(capChars(html, MAX_RAW_HTML_CHARS), "style"), "script");

  return (
    withoutBlocks
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
      // `[^<>]` and not `[^>]`: a '<' ends a failed attempt at the next '<', so each
      // character is scanned once. With `[^>]` every '<' scans to the end of the input.
      .replace(/<[^<>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      // trimEnd per line: `/[ \t]+\n/` rescans a long run of spaces from every position.
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}
