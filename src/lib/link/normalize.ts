// Employer and role normalisation for the Linker. Pure, no I/O.

// Hiring platforms. Never an employer: they only carry the mail (GLOSSARY: Via).
const ATS_NAMES = new Set([
  "icims", "greenhouse", "lever", "workday", "myworkdayjobs", "ashby", "smartrecruiters",
  "taleo", "jobvite", "bamboohr", "successfactors", "oracle recruiting", "linkedin", "indeed",
  "hiring team", "talent acquisition", "recruiting", "careers",
]);

// Canonical names for employers that go by more than one. Extend as real mail shows more.
const EMPLOYER_ALIASES: Record<string, string> = {
  hpe: "hewlett packard enterprise",
  "hp enterprise": "hewlett packard enterprise",
  "hewlett packard enterprise": "hewlett packard enterprise",
  aws: "amazon web services",
  "amazon web services": "amazon web services",
};

const CORP_SUFFIX = /\b(inc|llc|ltd|corp|corporation|co|company|plc|gmbh|limited)\b\.?/g;

export function normalizeEmployer(raw: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(/[^a-z0-9& ]+/g, " ")
    .replace(CORP_SUFFIX, " ")
    .replace(/^the\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  return EMPLOYER_ALIASES[cleaned] ?? cleaned;
}

export function isAtsName(raw: string | null): boolean {
  const n = normalizeEmployer(raw);
  return n !== null && ATS_NAMES.has(n);
}

const ABBREVIATIONS: Record<string, string[]> = {
  swe: ["software", "engineer"],
  sde: ["software", "engineer"],
  sdet: ["software", "engineer", "test"],
  ml: ["machine", "learning"],
  ai: ["ai"],
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
    // "(Req #R-48213)", "#1234", "REQ-77", "job id 123": identifiers, not the title.
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
