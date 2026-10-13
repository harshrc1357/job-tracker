export const dynamic = "force-dynamic";

// Static chrome only, on purpose. Next renders a layout and its page CONCURRENTLY, and the
// database client is a single connection (max: 1, see db/client.ts). Two flows issuing
// queries at once pipeline down that one connection, which Supabase's transaction pooler
// stalls on (see the note in api/sync/route.ts). So the tab counts are loaded by each page,
// sequentially, after its own queries, via loadShellCounts.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className="topbar">
        <div className="title-block">
          <h1>Job Tracker</h1>
          <p>Auto-sorted from Gmail</p>
        </div>
        <div className="status-row">
          <div className="status-pill">
            <span className="dot" /> Gmail connected
          </div>
          <div className="status-pill">
            <span className="dot" style={{ background: "var(--coral)" }} /> Telegram reminders on
          </div>
          <a href="/api/auth/logout" style={{ fontSize: 13, color: "var(--ink-soft)", border: "1px solid var(--border)", borderRadius: 999, padding: "6px 14px", textDecoration: "none" }}>
            Log out
          </a>
        </div>
      </div>
      {children}
    </>
  );
}
