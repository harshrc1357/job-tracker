import { db, isDbConfigured } from "@/db/client";
import { applications } from "@/db/schema";
import { desc } from "drizzle-orm";
import { CATEGORIES, isReminderCategory, type Category } from "@/lib/categories";
import { MAX_REMINDERS_PER_APPLICATION, REMINDER_WINDOW_HOURS } from "@/lib/constants";
import { ApplicationsPanel } from "./ApplicationsPanel";

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

  // "Upcoming" means due within the reminder window (see REMINDER_WINDOW_HOURS) and
  // in a category the bot actually nudges about (Interview, Assessment, Offer) —
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
          <a
            href="/api/auth/logout"
            style={{
              fontSize: 13,
              color: "var(--ink-soft)",
              border: "1px solid var(--border)",
              borderRadius: 999,
              padding: "6px 14px",
              textDecoration: "none",
            }}
          >
            Log out
          </a>
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
          <ApplicationsPanel applications={all} />
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
