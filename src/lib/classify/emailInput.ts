// Turns a fetched Gmail message into the text the classifier actually reads.
//
// Two jobs, and they pull against each other:
//
// 1. Include the body. Deciding from the subject is what filed assessment invites as
//    "Applied" and lost their deadlines. The body is not optional context, it is the
//    evidence.
// 2. Keep it bounded. A marketing email is mostly footer, and paying to tokenize
//    3,000 characters of unsubscribe boilerplate buys nothing.
//
// So: head-and-tail truncation rather than a plain head cut. Deadlines and sign-offs
// live at the bottom of a long email, and a head-only cut throws exactly those away.

export type EmailForClassification = {
  subject: string;
  from: string;
  to: string;
  cc: string;
  // Plain text. Falls back to the Gmail snippet when the message had no text part.
  body: string;
  snippet: string;
  // Hints from prefilter.ts — evidence for the model to weigh, not a verdict.
  bulkSignals: readonly string[];
  // Whether one of the owner's addresses is an explicit To/Cc recipient. null when
  // OWNER_EMAIL is not configured, in which case the hint is simply omitted rather
  // than asserted as "no".
  directRecipient: boolean | null;
};

const MAX_BODY_CHARS = 5_000;
const TAIL_CHARS = 1_200;
const MAX_URL_CHARS = 120;
const MAX_HEADER_CHARS = 200;

export function buildClassifierInput(email: EmailForClassification): string {
  const body = condenseBody(email.body || email.snippet);
  const lines = [
    `From: ${clampHeader(email.from)}`,
    `To: ${clampHeader(email.to) || "(not shown)"}`,
  ];

  if (email.cc.trim()) lines.push(`Cc: ${clampHeader(email.cc)}`);
  lines.push(`Subject: ${clampHeader(email.subject)}`);

  // Stated as observations, never as a conclusion. Recruiters replying inside a live
  // conversation do send from platforms that set List-Unsubscribe, and a rule that
  // treated this as proof of advertising would drop real interview invites.
  if (email.bulkSignals.length > 0) {
    lines.push(
      `Bulk-mail headers present: ${email.bulkSignals.join(", ")} (a hint that this is a mass send, not proof)`
    );
  }

  if (email.directRecipient === false) {
    lines.push("The owner's address is not an explicit To/Cc recipient (a hint that this is a mass send, not proof)");
  }

  lines.push("", "Body:", body || "(empty)");
  return lines.join("\n");
}

// True when one of the owner's addresses is an explicit To/Cc recipient rather than
// a bcc'd name on a blast list. Weak evidence on its own — plenty of legitimate ATS
// mail goes out through a relay — which is why it is only ever a prompt hint.
export function isDirectRecipient(email: EmailForClassification, ownerEmail: string): boolean {
  const owner = ownerEmail.trim().toLowerCase();
  if (!owner) return false;
  return `${email.to} ${email.cc}`.toLowerCase().includes(owner);
}

function condenseBody(body: string): string {
  const cleaned = body
    // Quoted-printable soft breaks survive some ATS senders and split words in half.
    .replace(/=\r?\n/g, "")
    .replace(/\r\n/g, "\n")
    // Tracking URLs routinely run to 500+ characters of opaque query string. The host
    // and path carry every bit of the signal (hackerrank.com/test/..., calendly.com).
    .replace(/https?:\/\/\S+/g, (url) =>
      url.length > MAX_URL_CHARS ? `${url.slice(0, MAX_URL_CHARS)}…` : url
    )
    .replace(/[ \t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (cleaned.length <= MAX_BODY_CHARS) return cleaned;

  const head = cleaned.slice(0, MAX_BODY_CHARS - TAIL_CHARS);
  const tail = cleaned.slice(-TAIL_CHARS);
  return `${head}\n\n[...trimmed...]\n\n${tail}`;
}

function clampHeader(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= MAX_HEADER_CHARS ? flat : `${flat.slice(0, MAX_HEADER_CHARS)}…`;
}
