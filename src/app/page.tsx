import { db, isDbConfigured } from "@/db/client";
import { applications } from "@/db/schema";
import { desc } from "drizzle-orm";
import { CATEGORIES, CATEGORY_BADGE_CLASS, type Category } from "@/lib/categories";

export const dynamic = "force-dynamic";

type Row = typeof applications.$inferSelect;

export default async function DashboardPage() {
  if (!isDbConfigured) {
    return <SetupNotice reason="DATABASE_URL isn't set yet." />;
  }

  let all: Row[] = [];
  try {
    all = await db.select().from(applications).orderBy(desc(applications.receivedAt));
  } catch (err) {
    return <SetupNotice reason="Couldn't reach the database. Check DATABASE_URL." detail={String(err)} />;
  }

  const counts = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
  for (const row of all) {
    if (row.category in counts) counts[row.category as Category]++;
  }

  const now = Date.now();
  const upcoming = all
    .filter((row) => row.reminderDueAt && !row.reminderSent && row.reminderDueAt.getTime() > now)
    .sort((a, b) => a.reminderDueAt!.getTime() - b.reminderDueAt!.getTime())
    .slice(0, 5);

  // No arbitrary cap — this is the full pipeline, not a "recent" snippet. The table
  // itself scrolls internally (see .table-scroll in globals.css) so the page layout
  // stays put while the list underneath it grows to however many rows exist.
  const applicationsList = all;

  return (
    <>
      <header>
        <div className="title-block">
          <h1>Job Tracker</h1>
          <p>Auto-sorted from Gmail · {all.length} tracked</p>
        </div>
        <div className="status-row">
          <div className="status-pill">
            <span className="dot" /> Gmail connected
          </div>
          <div className="status-pill">
            <span className="dot" style={{ background: "var(--coral)" }} /> Telegram reminders on
          </div>
        </div>
      </header>

      <div className="stats">
        <div className="stat-card applied">
          <div className="num">{counts.Applied}</div>
          <div className="label">Applied</div>
        </div>
        <div className="stat-card assessment">
          <div className="num">{counts.Assessment}</div>
          <div className="label">Assessment</div>
        </div>
        <div className="stat-card interview">
          <div className="num">{counts.Interview}</div>
          <div className="label">Interview</div>
        </div>
        <div className="stat-card offer">
          <div className="num">{counts.Offer}</div>
          <div className="label">Offer</div>
        </div>
        <div className="stat-card rejection">
          <div className="num">{counts.Rejection}</div>
          <div className="label">Rejection</div>
        </div>
        <div className="stat-card reminders">
          <div className="num">{upcoming.length}</div>
          <div className="label">Reminders due</div>
        </div>
      </div>

      <div className="grid-2">
        <div className="panel">
          <div className="panel-head">
            <h2>All applications</h2>
            <span className="date">{applicationsList.length} total</span>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Company / Role</th>
                  <th>Category</th>
                  <th>Received</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {applicationsList.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <div className="company">{row.company}</div>
                      <div className="role">{row.role ?? row.subject}</div>
                    </td>
                    <td>
                      <span className={CATEGORY_BADGE_CLASS[row.category as Category] ?? "badge applied"}>
                        <span className="dot" />
                        {row.category}
                      </span>
                    </td>
                    <td className="date">{formatDate(row.receivedAt)}</td>
                    <td className="bell">{reminderLabel(row)}</td>
                  </tr>
                ))}
                {applicationsList.length === 0 && (
                  <tr>
                    <td colSpan={4} className="empty-state">
                      No emails synced yet — /api/sync hasn't run, or nothing matched.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel side-card">
          <h3>Upcoming reminders</h3>
          {upcoming.length === 0 && <p className="empty-state">Nothing due in the next 24 hours.</p>}
          {upcoming.map((row) => (
            <div className="reminder-item" key={row.id}>
              <div className={`reminder-icon ${iconClass(row.category as Category)}`}>{icon(row.category as Category)}</div>
              <div>
                <div className="reminder-title">
                  {row.company} — {row.category.toLowerCase()}
                </div>
                <div className="reminder-sub">{row.reminderDueAt ? formatDate(row.reminderDueAt) : ""}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function reminderLabel(row: Row): string {
  if (!row.reminderDueAt) return "";
  return row.reminderSent ? "🔔 reminder sent" : "🔔 pending";
}

function iconClass(category: Category): string {
  if (category === "Interview") return "i";
  if (category === "Offer") return "o";
  return "a";
}

function icon(category: Category): string {
  if (category === "Interview") return "🎙️";
  if (category === "Offer") return "🎉";
  return "📝";
}

function formatDate(date: Date): string {
  return new Date(date).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function SetupNotice({ reason, detail }: { reason: string; detail?: string }) {
  return (
    <div style={{ maxWidth: 560, margin: "80px auto", textAlign: "center" }}>
      <h1 style={{ fontSize: 22, marginBottom: 12 }}>Job Tracker isn&apos;t configured yet</h1>
      <p style={{ color: "var(--ink-soft)", fontSize: 14 }}>{reason}</p>
      {detail && (
        <pre
          style={{
            marginTop: 16,
            textAlign: "left",
            fontSize: 12,
            background: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            padding: 16,
            overflowX: "auto",
          }}
        >
          {detail}
        </pre>
      )}
    </div>
  );
}
