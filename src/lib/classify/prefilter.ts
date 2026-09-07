// Free, deterministic first pass. Its only job is to throw away bulk job
// advertising before it costs an LLM call.
//
// The governing rule is asymmetry. Sending a promo email to the classifier costs
// roughly $0.0001. Rejecting a real one silently loses an interview invite, which is
// the failure this whole tool exists to prevent. So every rule here has to be one
// that CANNOT fire on a genuine reply about his own application, and everything
// merely suspicious is passed through as a signal for the model to weigh instead.
//
// That is why "apply now", "we're hiring" and List-Unsubscribe are explicitly not
// rejection rules: recruiters following up on live conversations use all three.

export type PrefilterInput = {
  subject: string;
  from: string;
  body: string;
  // Lowercased header name -> value. Only the bulk-mail headers are read.
  headers: Record<string, string>;
};

export type PrefilterVerdict =
  // Bulk advertising. Bank it in ignored_messages and never look at it again.
  | { decision: "reject"; reason: string; bulkSignals: string[] }
  // Worth a classification call. bulkSignals are hints, not conclusions.
  | { decision: "pass"; bulkSignals: string[] };

// Mailboxes that exist purely to send job adverts. Matched on the full address, so
// messages-noreply@linkedin.com (real recruiter InMail relay) is untouched.
const ALERT_SENDERS: RegExp[] = [
  /^jobalerts-noreply@linkedin\.com$/i,
  /^jobs-listings@linkedin\.com$/i,
  /^job-?alerts?@/i,
  /^alert@indeed\.com$/i,
  /^[a-z0-9._-]*@match\.indeed\.com$/i,
  /^invitetoapply@indeed\.com$/i,
  /^noreply@glassdoor\.com$/i,
  /^alerts?@glassdoor\.com$/i,
  /^no-?reply@ziprecruiter\.com$/i,
  /^jobalerts?@/i,
  /^info@(naukri|shine|monster)\.com$/i,
  /^alerts?@(naukri|monsterindia|dice|wellfound|angel\.co)\.com$/i,
];

// Subject shapes that only a digest blast produces. Each one has to be something a
// human recruiter would never write in a reply to a candidate.
const ALERT_SUBJECTS: RegExp[] = [
  /\b\d+\+?\s+new\s+jobs?\b/i,
  /\bjobs?\s+for\s+you\b/i,
  /\bjob\s+alert\b/i,
  /\bnew\s+jobs?\s+(matching|similar|like|based on)\b/i,
  /\brecommended\s+jobs?\b/i,
  /\bjobs?\s+you\s+(may|might)\s+(be interested in|like)\b/i,
  /\bjobs?\s+picked\s+for\s+you\b/i,
  /\byour\s+(daily|weekly)\s+job\b/i,
  /\bmore\s+jobs?\s+for\s+you\b/i,
];

export function prefilter(input: PrefilterInput): PrefilterVerdict {
  const bulkSignals = collectBulkSignals(input.headers);
  const address = extractAddress(input.from);

  const senderRule = ALERT_SENDERS.find((pattern) => pattern.test(address));
  if (senderRule) {
    return { decision: "reject", reason: `bulk job-alert sender: ${address}`, bulkSignals };
  }

  const subjectRule = ALERT_SUBJECTS.find((pattern) => pattern.test(input.subject));
  if (subjectRule) {
    return { decision: "reject", reason: `job-digest subject: ${subjectRule}`, bulkSignals };
  }

  return { decision: "pass", bulkSignals };
}

function collectBulkSignals(headers: Record<string, string>): string[] {
  const signals: string[] = [];
  const get = (name: string) => headers[name] ?? headers[name.toLowerCase()];

  if (get("list-unsubscribe")) signals.push("list-unsubscribe");
  if (get("list-id")) signals.push("list-id");
  if (/^(bulk|list|junk)$/i.test((get("precedence") ?? "").trim())) signals.push("precedence-bulk");
  if (/(promotional|marketing|bulk)/i.test(get("x-campaign-type") ?? "")) signals.push("campaign-header");
  if (get("x-mailer-campaign") || get("x-campaignid") || get("x-sfmc-stack")) {
    signals.push("campaign-header");
  }

  return signals;
}

// "LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>" -> the address, lowercased.
// Falls back to the whole trimmed header for the rare From line with no brackets.
function extractAddress(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return (match ? match[1] : from).trim().toLowerCase();
}
