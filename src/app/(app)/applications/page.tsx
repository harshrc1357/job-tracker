import Link from "next/link";
import { db, isDbConfigured } from "@/db/client";
import { loadAppRows } from "@/lib/link/actions";
import { APPLICATION_FILTERS, applicationCounts, filterApplications, type AppRow, type ApplicationFilter } from "@/lib/link/views";
import { shortDate } from "@/lib/format";
import { Notice } from "../Notice";
import { TabNav } from "../TabNav";
import { loadShellCounts } from "../shell";

const LABEL: Record<ApplicationFilter, string> = {
  all: "All", "applied-only": "Applied only", progressed: "Progressed", rejected: "Rejected", ghosted: "Ghosted 30d+",
};
const PAGE_SIZE = 200;

export default async function ApplicationsPage({
  searchParams,
}: {
  searchParams: Promise<{ f?: string; company?: string; page?: string }>;
}) {
  if (!isDbConfigured) return <Notice>DATABASE_URL isn&apos;t set yet.</Notice>;
  const { f, company, page } = await searchParams;
  const filter = (APPLICATION_FILTERS as readonly string[]).includes(f ?? "") ? (f as ApplicationFilter) : "all";

  let rows: AppRow[];
  try {
    rows = await loadAppRows(db);
  } catch {
    return <Notice>Couldn&apos;t reach the database. Check DATABASE_URL.</Notice>;
  }
  const shell = await loadShellCounts(db, rows);
  const now = new Date();
  const counts = applicationCounts(rows, now);
  const employers = [...new Set(rows.map((r) => r.employer))].sort((a, b) => a.localeCompare(b));
  const list = filterApplications(rows, filter, now, company);
  const pageNo = Math.max(1, Number(page) || 1);
  const shown = list.slice((pageNo - 1) * PAGE_SIZE, pageNo * PAGE_SIZE);
  const href = (over: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    const merged = { f: filter === "all" ? undefined : filter, company, ...over };
    for (const [k, v] of Object.entries(merged)) if (v) q.set(k, v);
    const s = q.toString();
    return `/applications${s ? `?${s}` : ""}`;
  };

  return (
    <>
      <TabNav counts={shell} />
      <div className="chips">
        {APPLICATION_FILTERS.map((k) => (
          <Link key={k} href={href({ f: k === "all" ? undefined : k, page: undefined })} className={`chip ${k === filter ? "active" : ""}`}>
            {LABEL[k]} {counts[k]}
          </Link>
        ))}
        <form action="/applications" className="row-form">
          {f && <input type="hidden" name="f" value={filter} />}
          <select name="company" defaultValue={company ?? ""} aria-label="Company">
            <option value="">Company: any</option>
            {employers.map((e) => (
              <option key={e} value={e}>{e}</option>
            ))}
          </select>
          <button className="btn" type="submit">Apply</button>
        </form>
      </div>
      <div className="panel">
        {shown.length === 0 ? (
          <div className="empty-state">No applications match.</div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Company</th><th>Role</th><th>Stage</th><th>Emails</th><th>Applied</th><th>Last activity</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((a) => (
                  <tr key={a.id} className={a.stage === "Applied" && !a.rejected ? "muted-row" : undefined}>
                    <td><Link className="table-link company" href={`/applications/${a.id}`}>{a.employer}</Link></td>
                    <td>{a.role ?? <span className="dim">— role not stated</span>}</td>
                    <td>
                      <span className={`badge ${a.rejected ? "rejection" : a.stage.toLowerCase()}`}>
                        {a.rejected ? "Rejected" : a.stage === "Interview" && a.interviewRound > 0 ? `Interview R${a.interviewRound}` : a.stage}
                      </span>
                    </td>
                    <td className="dim">{a.emailCount}</td>
                    <td className="dim">{shortDate(a.appliedAt)}</td>
                    <td>{shortDate(a.lastActivityAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {list.length > PAGE_SIZE && (
        <div className="chips" style={{ marginTop: 16 }}>
          {pageNo > 1 && <Link className="chip" href={href({ page: String(pageNo - 1) })}>← Newer</Link>}
          <span className="chip">{(pageNo - 1) * PAGE_SIZE + 1}–{Math.min(pageNo * PAGE_SIZE, list.length)} of {list.length}</span>
          {pageNo * PAGE_SIZE < list.length && <Link className="chip" href={href({ page: String(pageNo + 1) })}>Older →</Link>}
        </div>
      )}
    </>
  );
}
