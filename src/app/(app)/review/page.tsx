import { asc, eq, isNull } from "drizzle-orm";
import { db, isDbConfigured } from "@/db/client";
import { applications, jobApplications, reviewItems } from "@/db/schema";
import { shortDate } from "@/lib/format";
import { loadAppRows } from "@/lib/link/actions";
import { normalizeEmployer } from "@/lib/link/normalize";
import { reviewChoices } from "@/lib/link/reviewChoices";
import { Notice } from "../Notice";
import { TabNav } from "../TabNav";
import { loadShellCounts } from "../shell";
import { resolveReviewAction } from "../actions";

type Candidate = { applicationId: number; score: number };

export default async function ReviewPage() {
  if (!isDbConfigured) return <Notice>DATABASE_URL isn&apos;t set yet.</Notice>;
  const items = await db
    .select({
      id: reviewItems.id, evidence: reviewItems.evidence, confidence: reviewItems.confidence, candidates: reviewItems.candidates,
      subject: applications.subject, company: applications.company, employer: applications.employer, role: applications.role,
      fromEmail: applications.fromEmail, receivedAt: applications.receivedAt,
    })
    .from(reviewItems)
    .innerJoin(applications, eq(applications.id, reviewItems.emailId))
    .where(isNull(reviewItems.resolvedAt))
    .orderBy(asc(applications.receivedAt));
  const apps = new Map((await db.select().from(jobApplications)).map((a) => [a.id, a]));
  const shell = await loadShellCounts(db, await loadAppRows(db));

  return (
    <>
      <TabNav counts={shell} />
      <p className="dim" style={{ marginBottom: 16 }}>
        Only emails the linker would not decide. When it is unsure it splits rather than merges, so a wrong guess is two applications, never a live interview hidden behind another role&apos;s rejection.
      </p>
      {items.length === 0 ? (
        <Notice>Nothing to review.</Notice>
      ) : (
        <div className="review-list">
          {items.map((it) => {
            const employer = normalizeEmployer(it.employer);
            const openAtEmployer = employer
              ? [...apps.values()].filter((a) => a.status === "open" && normalizeEmployer(a.employer) === employer).map((a) => ({ id: a.id, lastActivityAt: a.lastActivityAt }))
              : [];
            const candidates = (it.candidates as Candidate[]).filter((c) => apps.has(c.applicationId));
            const choices = reviewChoices(candidates, openAtEmployer);
            return (
              <div key={it.id} className="review-card">
                <h3>“{it.subject ?? "(no subject)"}” — {shortDate(it.receivedAt)}</h3>
                <div className="dim" style={{ fontSize: 13 }}>
                  {it.company}{it.role ? ` · ${it.role}` : ""} · {it.fromEmail ?? "unknown sender"}
                </div>
                <div className="why">{it.evidence} · confidence {it.confidence.toFixed(2)}</div>
                <div className="choices">
                  {choices.attach.map((id) => {
                    const a = apps.get(id)!;
                    return (
                      <form key={id} action={resolveReviewAction}>
                        <input type="hidden" name="itemId" value={it.id} />
                        <input type="hidden" name="choice" value="attach" />
                        <input type="hidden" name="applicationId" value={id} />
                        <button className={`btn ${choices.recommended === id ? "primary" : ""}`} type="submit">
                          {a.employer} · {a.role ?? "role not stated"} · {a.stage}
                        </button>
                      </form>
                    );
                  })}
                  <form action={resolveReviewAction}>
                    <input type="hidden" name="itemId" value={it.id} />
                    <input type="hidden" name="choice" value="new" />
                    <button className={`btn ${choices.recommended === "new" ? "primary" : ""}`} type="submit">New application</button>
                  </form>
                  <form action={resolveReviewAction}>
                    <input type="hidden" name="itemId" value={it.id} />
                    <input type="hidden" name="choice" value="ignore" />
                    <button className="btn" type="submit">Not a job email</button>
                  </form>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
