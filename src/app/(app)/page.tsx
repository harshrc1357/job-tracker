import Link from "next/link";
import { db, isDbConfigured } from "@/db/client";
import { loadAppRows } from "@/lib/link/actions";
import { PIPELINE_FILTERS, daysQuiet, isGhosted, pipelineApps, pipelineCounts, type AppRow, type PipelineFilter } from "@/lib/link/views";
import { MANUAL_STAGE_FLAG, STAGES } from "@/lib/link/types";
import { shortDate } from "@/lib/format";
import { Notice } from "./Notice";
import { TabNav } from "./TabNav";
import { loadShellCounts } from "./shell";

const LABEL: Record<PipelineFilter, string> = {
  active: "Active", interview: "Interview", assessment: "Assessment", screening: "Screening",
  offer: "Offer", "needs-action": "Needs action", closed: "Closed",
};

export default async function PipelinePage({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  if (!isDbConfigured) return <Notice>DATABASE_URL isn&apos;t set yet.</Notice>;
  const { f } = await searchParams;
  const filter = (PIPELINE_FILTERS as readonly string[]).includes(f ?? "") ? (f as PipelineFilter) : "active";

  let rows: AppRow[];
  try {
    rows = await loadAppRows(db);
  } catch {
    return <Notice>Couldn&apos;t reach the database. Check DATABASE_URL.</Notice>;
  }
  const counts = pipelineCounts(rows);
  const shell = await loadShellCounts(db, rows);
  const cards = pipelineApps(rows, filter);
  const now = new Date();

  return (
    <>
      <TabNav counts={shell} />
      <div className="chips">
        {PIPELINE_FILTERS.map((k) => (
          <Link key={k} href={k === "active" ? "/" : `/?f=${k}`} className={`chip ${k === filter ? "active" : ""}`}>
            {LABEL[k]} {counts[k]}
          </Link>
        ))}
      </div>
      {cards.length === 0 ? (
        <Notice>
          {rows.length === 0
            ? "No applications yet. Once the linker has run, applications that move past Applied show up here."
            : "Nothing here. Applied-only applications live on the Applications tab."}
        </Notice>
      ) : (
        <div className="cards">
          {cards.map((a) => (
            <PipelineCard key={a.id} app={a} quietDays={isGhosted(a, now) ? daysQuiet(a, now) : null} />
          ))}
        </div>
      )}
    </>
  );
}

const STEP_LABEL: Record<string, string> = { Applied: "Applied", Screening: "Screen", Assessment: "Assess", Interview: "Interview", Offer: "Offer" };

// quietDays is set only when the application is Ghosted (open, no email for 30+ days).
function PipelineCard({ app, quietDays }: { app: AppRow; quietDays: number | null }) {
  const at = STAGES.indexOf(app.stage);
  const stageText = app.stage === "Interview" && app.interviewRound > 0 ? `Interview · round ${app.interviewRound}` : app.stage;
  return (
    <Link href={`/applications/${app.id}`} className={`pcard s-${app.stage.toLowerCase()} ${app.rejected ? "closed" : ""}`}>
      <div className="employer">{app.employer}</div>
      <h3>{app.role ?? "Role not stated"}</h3>
      <span className={`badge ${app.rejected ? "rejection" : app.stage.toLowerCase()}`}>
        <span className="dot" />
        {app.rejected ? `Rejected · was ${stageText}` : stageText}
      </span>
      {quietDays !== null && <span className="badge ghosted">Ghosted · quiet {quietDays} days</span>}
      <div className="stepper" aria-hidden="true">
        {STAGES.map((s, i) => (
          <div key={s} className={`step ${i < at ? "done" : i === at ? "now" : ""}`}>
            <span className="dot" />
            {STEP_LABEL[s]}
          </div>
        ))}
      </div>
      <div className="meta">
        <b>{app.emailCount}</b> {app.emailCount === 1 ? "email" : "emails"} · last {shortDate(app.lastActivityAt)}
        {app.needsReview && <span className="flag"> · a linked email needs review</span>}
        {app.flags.filter((x) => x !== MANUAL_STAGE_FLAG).map((x) => (
          <span key={x} className="flag"> · {x}</span>
        ))}
      </div>
    </Link>
  );
}
