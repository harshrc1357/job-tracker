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
  // Whether the subject line states, possessively, that this is HIS application to a
  // named role. Computed by statesOwnApplication below rather than left to the model.
  ownApplicationSubject: boolean;
};

// LinkedIn and similar relays send application receipts whose entire content is the
// subject — "Your application to AI Engineer, Software at Delmar Secure AI" — over a
// body that is nothing but "Your update from <company>", a profile blurb and an
// unsubscribe footer. Asked to judge those, the model flips: three real rows of the
// identical shape came back Applied, "generic update" and "job alert" on the same run.
//
// It is not a hard question, it is an underdetermined one, and the fix is to stop
// asking it. The possessive is decidable from the subject alone, so it is decided
// here and passed in as a stated fact.
//
// Deliberately narrow. It requires "your application" AND a preposition introducing a
// named role or company, so it fires on "your application to X" and "your application
// was sent to X" but not on "your application could be a match for these roles" or
// any phrasing that invites him to start something new.
const OWN_APPLICATION_SUBJECT =
  /\byour\s+application\b[^.!?]{0,40}?\b(to|at|for|was\s+sent\s+to|has\s+been\s+(sent|submitted|received))\b/i;

// "Complete your application to unlock 6 new matches" satisfies the pattern above and
// means the exact opposite: an imperative aimed at him, asking him to start or finish
// something. An application he has been asked to complete is not one he has made.
const IMPERATIVE_PREFIX = /\b(complete|start|finish|submit|continue|resume|update)\s+your\s+application\b/i;

export function statesOwnApplication(subject: string): boolean {
  if (IMPERATIVE_PREFIX.test(subject)) return false;
  return OWN_APPLICATION_SUBJECT.test(subject);
}

const MAX_BODY_CHARS = 5_000;
const TAIL_CHARS = 1_200;
const MAX_URL_CHARS = 120;
const MAX_HEADER_CHARS = 200;

// Anyone can send the owner an email, so every character of it is attacker input. Two
// rules keep it from steering the classifier:
//
// 1. The facts the app computed (below) go in the SYSTEM message, via buildSystemPrompt
//    in prompt.ts. They used to sit in the user message next to the email, where a body
//    line reading "Signal: ... Question 1 is therefore YES" looked exactly like ours.
// 2. The email goes in the user message between <email> and </email>, and the prompt
//    says that block is data. Anything in it that looks like a delimiter or one of our
//    labels is removed first, so it cannot close the block or pose as a fact.
export function classifierFacts(email: EmailForClassification): string[] {
  const facts: string[] = [];

  // Stated before the bulk hints on purpose: it is the stronger signal, and it is a
  // fact about the subject rather than a guess about intent.
  if (email.ownApplicationSubject) {
    facts.push(
      "Signal: the subject states this is HIS OWN application to a named role. Question 1 is therefore YES."
    );
  }

  // Stated as observations, never as a conclusion. Recruiters replying inside a live
  // conversation do send from platforms that set List-Unsubscribe, and a rule that
  // treated this as proof of advertising would drop real interview invites.
  if (email.bulkSignals.length > 0) {
    facts.push(
      `Bulk-mail headers present: ${email.bulkSignals.join(", ")} (a hint that this is a mass send, not proof)`
    );
  }

  if (email.directRecipient === false) {
    facts.push("The owner's address is not an explicit To/Cc recipient (a hint that this is a mass send, not proof)");
  }

  return facts;
}

export function buildClassifierInput(email: EmailForClassification): string {
  const body = condenseBody(neutralize(email.body || email.snippet));
  const header = (value: string) => clampHeader(stripDelimiters(stripInvisible(value)));
  const lines = ["<email>", `From: ${header(email.from)}`, `To: ${header(email.to) || "(not shown)"}`];

  if (email.cc.trim()) lines.push(`Cc: ${header(email.cc)}`);
  lines.push(`Subject: ${header(email.subject)}`, "", "Body:", body || "(empty)", "</email>");
  return lines.join("\n");
}

// Zero-width and direction marks. Invisible to a reader and to the model's sense of the
// word, but they split "Signal" so a pattern no longer sees it.
const INVISIBLE = /[​-‏⁠﻿]/g;

// <email>, </email>, and spaced or cased variants of either.
const DELIMITER = /<\s*\/?\s*email\s*>/gi;

// A body line that poses as one of the labels this file writes: the computed facts
// (classifierFacts) and the "Body:" header. Leading spaces and quote marks are allowed,
// because a forged line can hide inside a quoted reply. "Signal" and "Body" need a colon,
// so an ordinary sentence about a signal or a body stays.
const FORGED_LABEL =
  /^[\s>*_#|-]*(signal\s*:|body\s*:|bulk-mail headers|the owner's address is not an explicit)/i;

function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, "");
}

// Repeated until nothing changes: removing one from "<em<email>ail>" makes another.
function stripDelimiters(text: string): string {
  let current = text;
  for (let next = current.replace(DELIMITER, ""); next !== current; next = current.replace(DELIMITER, "")) {
    current = next;
  }
  return current;
}

function neutralize(body: string): string {
  return stripDelimiters(stripInvisible(body))
    .split("\n")
    .filter((line) => !FORGED_LABEL.test(line))
    .join("\n");
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
