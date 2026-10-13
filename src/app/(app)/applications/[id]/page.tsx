import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { db, isDbConfigured } from "@/db/client";
import { applications, jobApplications } from "@/db/schema";
import { STAGES } from "@/lib/link/types";
import { fullDate } from "@/lib/format";
import { loadAppRows } from "@/lib/link/actions";
import { Notice } from "../../Notice";
import { TabNav } from "../../TabNav";
import { loadShellCounts } from "../../shell";
import { detachEmailAction, mergeAction, setStageAction, splitAction } from "../../actions";

export default async function ApplicationDetail({ params }: { params: Promise<{ id: string }> }) {
  if (!isDbConfigured) return <Notice>DATABASE_URL isn&apos;t set yet.</Notice>;
  const { id: raw } = await params;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const [app] = await db.select().from(jobApplications).where(eq(jobApplications.id, id));
  if (!app) notFound();
  const emails = await db
    .select({
      id: applications.id, category: applications.category, subject: applications.subject, fromEmail: applications.fromEmail,
      receivedAt: applications.receivedAt, threadId: applications.threadId, linkConfidence: applications.linkConfidence,
      linkEvidence: applications.linkEvidence, linkFlagged: applications.linkFlagged,
    })
    .from(applications)
    .where(and(eq(applications.jobApplicationId, id), eq(applications.linkState, "linked")))
    .orderBy(asc(applications.receivedAt));
  const others = (await db.select().from(jobApplications)).filter((a) => a.id !== id);
  others.sort((a, b) => Number(b.employer === app.employer) - Number(a.employer === app.employer) || a.employer.localeCompare(b.employer));

  const shell = await loadShellCounts(db, await loadAppRows(db));

  // The weakest link is the honest summary of "how sure are we this is one application".
  const confidences = emails.map((e) => e.linkConfidence).filter((c): c is number => c !== null);
  const weakest = confidences.length ? Math.min(...confidences) : null;
  const rejected = app.status === "rejected";
  const stageText = app.stage === "Interview" && app.interviewRound > 0 ? `Interview · round ${app.interviewRound}` : app.stage;

  return (
    <>
    <TabNav counts={shell} />
    <div className="panel">
      <div className="detail-wrap">
        <p><Link className="table-link dim" href="/">← Pipeline</Link></p>
        <div className="detail-top">
          <div>
            <div className="employer dim" style={{ textTransform: "uppercase", letterSpacing: "0.06em", fontSize: 12, fontWeight: 600, marginTop: 12 }}>{app.employer}</div>
            <h2 style={{ fontSize: 24, margin: "4px 0 12px" }}>{app.role ?? "Role not stated"}</h2>
            <span className={`badge ${rejected ? "rejection" : app.stage.toLowerCase()}`}>
              <span className="dot" />
              {rejected ? `Rejected · was ${stageText}` : stageText}
            </span>
            {app.flags.filter((f) => f !== "manual-stage").map((f) => (
              <span key={f} className="badge reminder" style={{ marginLeft: 8 }}>{f}</span>
            ))}
          </div>
          {weakest !== null && (
            <div className={`confidence ${weakest < 0.9 ? "low" : ""}`}>
              <div className="dim" style={{ fontSize: 13 }}>Weakest link</div>
              <div className="num">{weakest.toFixed(2)}</div>
              <div className="dim" style={{ fontSize: 12 }}>{emails.length} linked {emails.length === 1 ? "email" : "emails"}</div>
            </div>
          )}
        </div>

        <ol className="timeline">
          {[...emails].reverse().map((e) => (
            <li key={e.id} className={`tl-item k-${e.category}`}>
              <div className="tl-title">
                {fullDate(e.receivedAt)} · {e.category}
                <span className="tl-actions">
                  <form action={detachEmailAction}>
                    <input type="hidden" name="appId" value={id} />
                    <input type="hidden" name="emailId" value={e.id} />
                    <button className="btn danger" type="submit" title="Not this application: send it back to Review">Detach</button>
                  </form>
                </span>
              </div>
              <div className="tl-sub">“{e.subject ?? "(no subject)"}” — {e.fromEmail ?? "unknown sender"}</div>
              <div className="tl-sub">
                {e.linkConfidence !== null && `match ${e.linkConfidence.toFixed(2)}`}
                {e.linkEvidence ? ` · ${e.linkEvidence}` : ""}
                {e.linkFlagged ? " · flagged for a look" : ""}
              </div>
            </li>
          ))}
          {emails.length === 0 && <li className="tl-item"><div className="tl-sub">No emails linked.</div></li>}
        </ol>

        <div className="overrides">
          <h4>Override</h4>
          <form action={setStageAction} className="row-form">
            <input type="hidden" name="appId" value={id} />
            <label className="dim" htmlFor="stage">Change stage</label>
            <select id="stage" name="stage" defaultValue={app.stage}>
              {STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <button className="btn" type="submit">Set stage</button>
          </form>

          {emails.length > 1 && (
            <form action={splitAction} className="row-form" style={{ alignItems: "flex-start", flexDirection: "column" }}>
              <input type="hidden" name="appId" value={id} />
              <span className="dim">Split: tick the emails that belong to a different role, then name it.</span>
              {emails.map((e) => (
                <label key={e.id} className="row-form" style={{ fontSize: 13 }}>
                  <input type="checkbox" name="emailId" value={e.id} /> {e.category} · {e.subject ?? "(no subject)"}
                </label>
              ))}
              <div className="row-form">
                <input type="text" name="role" placeholder="Role of the new application" />
                <button className="btn" type="submit">Split into new application</button>
              </div>
            </form>
          )}

          {others.length > 0 && (
            <form action={mergeAction} className="row-form">
              <input type="hidden" name="appId" value={id} />
              <label className="dim" htmlFor="intoId">Merge this into</label>
              <select id="intoId" name="intoId">
                {others.map((o) => <option key={o.id} value={o.id}>{o.employer} · {o.role ?? "role not stated"}</option>)}
              </select>
              <button className="btn" type="submit">Merge</button>
            </form>
          )}
          <p className="dim" style={{ fontSize: 12 }}>Every override is saved as a labelled example, so the linker can be measured against your corrections.</p>
        </div>
      </div>
    </div>
    </>
  );
}
