import { db, isDbConfigured } from "@/db/client";
import { applications, jobApplications } from "@/db/schema";
import { desc } from "drizzle-orm";
import { CATEGORIES, isReminderCategory, type Category } from "@/lib/categories";
import { MAX_REMINDERS_PER_APPLICATION, REMINDER_WINDOW_HOURS } from "@/lib/constants";
import { loadAppRows } from "@/lib/link/actions";
import { TabNav } from "../TabNav";
import { loadShellCounts } from "../shell";
import { ApplicationsPanel, type ApplicationListRow } from "../../ApplicationsPanel";

export const dynamic = "force-dynamic";

type Row = ApplicationListRow;

// Every column the list, the search box, the stat cards and the reminders panel
// actually read. Deliberately written out rather than `select()`, because the one
// column missing from it is the entire point.
//
// bodyHtml is the sanitized full HTML of every email, and at 212 rows it was 1863 kB
// of a 2142 kB page payload — 87% of the bytes, shipped on every single load, to
// render one email that the user has not clicked yet. It is now fetched per message
// from /api/applications/[id] when a row is selected.
//
// body (the plain-text rendering) stays: it is only 279 kB across the whole table and
// matchesQuery searches it, which is what makes searching a role title or a
// recruiter's name find ATS mail whose subject line mentions neither. It also means
// the detail pane has text to show instantly while the HTML is still in flight.
const LIST_COLUMNS = {
  id: applications.id,
  company: applications.company,
  role: applications.role,
  category: applications.category,
  subject: applications.subject,
  snippet: applications.snippet,
  body: applications.body,
  fromEmail: applications.fromEmail,
  receivedAt: applications.receivedAt,
  reminderDueAt: applications.reminderDueAt,
  reminderCount: applications.reminderCount,
  reminderSent: applications.reminderSent,
  // Which application each email was attached to, so a wrong link is visible (and
  // fixable from the application page) from the one list that shows every email.
  jobApplicationId: applications.jobApplicationId,
  linkState: applications.linkState,
  linkFlagged: applications.linkFlagged,
} as const;

export default async function DashboardPage() {
  if (!isDbConfigured) {
    return <SetupNotice reason="DATABASE_URL isn't set yet." />;
  }

  let all: Row[] = [];
  const appLabels: Record<number, string> = {};
  let shell: Awaited<ReturnType<typeof loadShellCounts>> = null;
  try {
    all = await db
      .select(LIST_COLUMNS)
      .from(applications)
      .orderBy(desc(applications.receivedAt));
    for (const a of await db.select().from(jobApplications)) {
      appLabels[a.id] = a.role ? `${a.employer} · ${a.role}` : `${a.employer} · role unknown`;
    }
    shell = await loadShellCounts(db, await loadAppRows(db));
  } catch (err) {
    return <SetupNotice reason="Couldn't reach the database. Check DATABASE_URL." detail={String(err)} />;
  }

  const counts = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
  for (const row of all) {
    if (row.category in counts) counts[row.category as Category]++;
  }

  // "Upcoming" means due within the reminder window (see REMINDER_WINDOW_HOURS) and
  // in a category the bot actually nudges about (Screening, Interview, Assessment, Offer) —
  // mirrors the sync cron's own second pass exactly, so the dashboard never shows
  // something as upcoming that the bot wouldn't also be about to ping about.
  const now = Date.now();
  const windowEnd = now + REMINDER_WINDOW_HOURS * 60 * 60 * 1000;
  const upcoming = all
    .filter(
      (row) =>
        row.reminderDueAt &&
        !row.reminderSent &&
        isReminderCategory(row.category) &&
        row.reminderDueAt.getTime() > now &&
        row.reminderDueAt.getTime() <= windowEnd,
    )
    .sort((a, b) => a.reminderDueAt!.getTime() - b.reminderDueAt!.getTime());

  return (
    <>

      <TabNav counts={shell} />
      <div className="stats">
        <div className="stat-card applied">
          <div className="num">{counts.Applied}</div>
          <div className="label">Applied</div>
        </div>
        <div className="stat-card screening">
          <div className="num">{counts.Screening}</div>
          <div className="label">Screening</div>
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
        <div className="stat-card verification">
          <div className="num">{counts.Verification}</div>
          <div className="label">Verification</div>
        </div>
        <div className="stat-card reminders">
          <div className="num">{upcoming.length}</div>
          <div className="label">Reminders due</div>
        </div>
      </div>

      <div className="stack-y">
        {all.length === 0 ? (
          <div className="panel">
            <div className="empty-state">No emails synced yet — /api/sync hasn't run, or nothing matched.</div>
          </div>
        ) : (
          <ApplicationsPanel applications={all} appLabels={appLabels} />
        )}

        <div className="panel side-card">
          <h3>Upcoming reminders</h3>
          {upcoming.length === 0 && (
            <p className="empty-state">Nothing due in the next {REMINDER_WINDOW_HOURS} hours.</p>
          )}
          {upcoming.length > 0 && (
            <div className="reminders-grid">
              {upcoming.map((row) => (
                <div className="reminder-item" key={row.id}>
                  <div className={`reminder-icon ${iconClass(row.category as Category)}`}>
                    {icon(row.category as Category)}
                  </div>
                  <div>
                    <div className="reminder-title">
                      {row.company} — {row.category.toLowerCase()}
                    </div>
                    <div className="reminder-sub">
                      {row.reminderDueAt ? formatDate(row.reminderDueAt) : ""}
                      {` · ${row.reminderCount}/${MAX_REMINDERS_PER_APPLICATION} sent`}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
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
