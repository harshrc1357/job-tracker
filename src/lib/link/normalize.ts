// Employer and role normalisation for the Linker. Pure, no I/O.

// Hiring platforms. Never an employer: they only carry the mail (GLOSSARY: Via).
const ATS_NAMES = new Set([
  "icims", "greenhouse", "lever", "workday", "myworkdayjobs", "ashby", "smartrecruiters",
  "taleo", "jobvite", "bamboohr", "successfactors", "oracle recruiting", "linkedin", "indeed",
  "hiring team", "talent acquisition", "recruiting", "careers",
  // Job boards and an apply-for-you service: they carry mail for other companies.
  "ziprecruiter", "pluto", "talentpluto",
]);

// Canonical names for employers that go by more than one. Extend as real mail shows more.
const EMPLOYER_ALIASES: Record<string, string> = {
  hpe: "hewlett packard enterprise",
  "hp enterprise": "hewlett packard enterprise",
  "hewlett packard enterprise": "hewlett packard enterprise",
  aws: "amazon web services",
  "amazon web services": "amazon web services",
  getorbit: "orbit",
  "cedar fellowship": "cedar",
};

const CORP_SUFFIX = /\b(inc|incorporated|llc|ltd|corp|corporation|co|company|plc|gmbh|limited)\b\.?/g;

// A web address on a name: "Ravenna.io, Inc." is Ravenna.
const DOMAIN_SUFFIX = /\.(com|io|ai|net|org|dev|app)\b/g;

// Words that say what kind of company it is, not which one: "Sorrel Technologies" is
// Sorrel. Kept short on purpose. A word that can tell two companies apart ("Health",
// "Computer", "Systems") must stay, or "Zephyr" and "Zephyr Health" would merge.
const KIND_OF_COMPANY = new Set([
  "group", "technologies", "technology", "solutions", "integration", "management", "consulting", "holdings", "careers",
]);

function dropTrailingKindWords(name: string): string {
  const words = name.split(" ");
  while (words.length > 1 && KIND_OF_COMPANY.has(words[words.length - 1])) words.pop();
  return words.join(" ");
}

// A form letter whose blank was never filled in: "[company name]", "<Position>", "{role}".
export function isTemplateText(raw: string | null): boolean {
  return raw !== null && /^\s*[[<{].*[\]>}]\s*$/.test(raw);
}

// What a model writes in "employer" when the mail names no company: a note saying so, a list
// of several, or a description. Taken from real rows. A hedge after a real name ("KVG? (...)")
// is not here: the name is still usable.
const NON_EMPLOYER_PHRASES = [
  /\bnot an employer\b/,
  /\b(company|client|employer|organization) not (named|stated|given)\b/,
  /\bnot a single employer\b/,
  /^the role\b/,
  /\(multiple\)/,
  /\boutreach for a role\b/,
  /\(job:/,
  /\bco-founded by\b/,
];

export function isNonEmployer(raw: string | null): boolean {
  if (raw === null) return false;
  const lower = raw.toLowerCase();
  return NON_EMPLOYER_PHRASES.some((phrase) => phrase.test(lower));
}

// What a model writes in "role" when the email names none: a sentence about the application,
// a note that no role was named, or the employer's own name. Taken from real rows.
const NON_ROLE_PHRASES = [
  /\b(unnamed|unspecified)\b/,
  /\bnot (stated|specified|named|mentioned)\b/,
  /\byou applied\b/,
  /\byour application\b/,
  /\bapplication (at|to|for)\b/,
  /\bthank you for\b/,
  // A sentence about a code, not a job title such as "Security Code Reviewer".
  /\b(your|the) security code\b|^security code( for\b|$)/,
  /\bincomplete application\b/,
  /\bapplication (status|received|confirmation|form)\b/,
  /\bquestionnaire\b/,
  /\bnot explicit\b/,
  /\b(open role|current opening|career position|open position) at\b/,
  /^opportunity (at|with)\b/,
  // A whole role that names a kind of call or a placeholder, never a job.
  /^(job title|opportunity|strategy session|profile evaluation)$/,
];

export function isNonRole(role: string | null, employer: string | null): boolean {
  if (role === null) return false;
  if (isTemplateText(role)) return true;
  const named = normalizeEmployer(role);
  if (named !== null && named === normalizeEmployer(employer)) return true;
  // "Pinecrest Caring role": the employer's name plus the word "role".
  const bare = normalizeEmployer(role.replace(/\s+role$/i, ""));
  if (bare !== null && bare !== named && bare === normalizeEmployer(employer)) return true;
  const lower = role.toLowerCase();
  return NON_ROLE_PHRASES.some((phrase) => phrase.test(lower));
}

export function usableRole(role: string | null, employer: string | null): string | null {
  return isNonRole(role, employer) ? null : role;
}

// The same email with template text and non-roles taken out of its employer and role.
export function withoutNonNames<T extends { employer: string | null; role: string | null }>(email: T): T {
  const employer = isTemplateText(email.employer) || isNonEmployer(email.employer) ? null : email.employer;
  const role = usableRole(email.role, email.employer);
  if (employer === email.employer && role === email.role) return email;
  return { ...email, employer, role };
}

export function normalizeEmployer(raw: string | null): string | null {
  if (!raw) return null;
  // "Hewlett Packard Enterprise (HPE)": the note in brackets is a second name or a parent.
  const withoutNote = raw.replace(/\([^)]*\)/g, " ");
  const source = /[a-z0-9]/i.test(withoutNote) ? withoutNote : raw;
  const cleaned = source
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .replace(DOMAIN_SUFFIX, " ")
    .replace(/[.,]/g, " ")
    .replace(/[^a-z0-9& ]+/g, " ")
    .replace(CORP_SUFFIX, " ")
    .replace(/^the\s+/, "")
    .replace(/\s+/g, " ")
    // "Acme via Greenhouse": what follows "via" is the platform that carried the mail.
    .replace(/\s+via\s+.*$/, "")
    .trim();
  if (!cleaned) return null;
  // The alias table is checked first: "Amazon Web Services" must not lose a word below.
  return EMPLOYER_ALIASES[cleaned] ?? dropTrailingKindWords(cleaned);
}

export function isAtsName(raw: string | null): boolean {
  const n = normalizeEmployer(raw);
  return n !== null && ATS_NAMES.has(n);
}

const MIN_NAME_LETTERS = 3;
const lettersIn = (s: string) => (s.match(/[a-z]/g) ?? []).length;

// "Dunmore / Everly" holds two names. A slash inside one name (K/RO, UN/VELT, Quill40/40) does
// not: it splits only when every part still has a real name of its own.
function alternatives(raw: string): string[] {
  // A slash inside a bracket note ("KVG? (brand/organization ...)") is not between two names.
  const parts = raw.replace(/\([^)]*\)/g, " ").split("/");
  if (parts.length < 2) return [raw];
  const names = parts.map(normalizeEmployer);
  return names.every((n) => n !== null && lettersIn(n) >= MIN_NAME_LETTERS) ? parts : [raw];
}

// Every name an employer string gives, with platform names left out. Empty when none is left.
export function employerKeys(raw: string | null): string[] {
  if (!raw) return [];
  const keys = alternatives(raw).map(normalizeEmployer).filter((k): k is string => k !== null && !ATS_NAMES.has(k));
  return [...new Set(keys)];
}

// Whether an employer string names a company at all. The Linker treats the same strings as an
// unresolved employer and sends the email to Review.
export function hasUsableEmployer(raw: string | null): boolean {
  return !isTemplateText(raw) && !isNonEmployer(raw) && employerKeys(raw).length > 0;
}

// Two employer strings are the same employer when they share a name.
export function sameEmployer(a: string | null, b: string | null): boolean {
  const keys = employerKeys(a);
  return employerKeys(b).some((k) => keys.includes(k));
}

const ABBREVIATIONS: Record<string, string[]> = {
  swe: ["software", "engineer"],
  sde: ["software", "engineer"],
  sdet: ["software", "engineer", "test"],
  ml: ["machine", "learning"],
  ai: ["ai"],
  assoc: ["associate"],
  sr: ["senior"],
  jr: ["junior"],
  eng: ["engineer"],
  engineering: ["engineer"],
  engineers: ["engineer"],
  intern: ["intern"],
  internship: ["intern"],
  i: ["1"],
  ii: ["2"],
  iii: ["3"],
};

const STOP = new Set(["the", "a", "an", "of", "and", "for", "to", "in", "at", "with", "role", "position", "job", "new", "grad"]);

// Spring/Summer/Fall/Winter and years distinguish separate openings of the same title,
// so they must never be dropped as noise.
const TERM = new Set(["spring", "summer", "fall", "autumn", "winter"]);

export function roleTokens(raw: string | null): string[] {
  if (!raw) return [];
  const withoutReq = raw
    .toLowerCase()
    // "(Req #R-00001)", "#1234", "REQ-77", "job id 123": identifiers, not the title.
    .replace(/\(?\b(req(uisition)?|job\s*id|id)\b[\s#:.-]*[a-z0-9-]*\)?/g, " ")
    .replace(/#\s*[a-z0-9-]+/g, " ")
    .replace(/\b[a-z]?-?\d{4,}\b/g, (m) => (/^(19|20)\d\d$/.test(m) ? m : " "));
  const words = withoutReq.replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const w of words) {
    if (STOP.has(w)) continue;
    const expanded = ABBREVIATIONS[w] ?? [w.replace(/s$/, "") === "engineer" ? "engineer" : w];
    out.push(...expanded);
  }
  return [...new Set(out)];
}

// 0..1. Different term or year is a hard 0: Spring 2027 and Summer 2026 are two roles.
export function roleSimilarity(a: string | null, b: string | null): number {
  const ta = roleTokens(a);
  const tb = roleTokens(b);
  if (ta.length === 0 || tb.length === 0) return 0;

  const termOf = (t: string[]) => t.filter((x) => TERM.has(x) || /^(19|20)\d\d$/.test(x)).sort().join("|");
  const termA = termOf(ta);
  const termB = termOf(tb);
  if (termA && termB && termA !== termB) return 0;

  const sa = new Set(ta);
  const sb = new Set(tb);
  const inter = [...sa].filter((x) => sb.has(x)).length;
  const union = new Set([...sa, ...sb]).size;
  // Each side carries a qualifier the other lacks ("Security" vs "Core Eng", "Backend" vs
  // "Frontend"): same title, different opening. Splitting is cheap, merging is not.
  if (inter < sa.size && inter < sb.size) return Math.min(inter / union, 0.45);
  return inter / union;
}
