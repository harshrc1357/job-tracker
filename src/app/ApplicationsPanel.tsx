"use client";

import { useMemo, useState } from "react";
import type { applications } from "@/db/schema";
import { CATEGORIES, CATEGORY_BADGE_CLASS, type Category } from "@/lib/categories";

type Row = typeof applications.$inferSelect;
type Tab = "All" | Category;

const TABS: Tab[] = ["All", ...CATEGORIES];

// Same soft/strong color pairing as the category badges (see CATEGORY_BADGE_CLASS),
// applied to the list-item avatar instead. "Applied" has no modifier class — it
// uses the plain .split-avatar default styling.
function avatarClass(category: string): string {
  switch (category) {
    case "Assessment":
      return "split-avatar assessment";
    case "Interview":
      return "split-avatar interview";
    case "Offer":
      return "split-avatar offer";
    case "Rejection":
      return "split-avatar rejection";
    case "Reminder":
      return "split-avatar reminder";
    default:
      return "split-avatar";
  }
}

function initials(company: string): string {
  return company.trim().slice(0, 2).toUpperCase() || "?";
}

function formatShortDate(date: Date): string {
  return new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatFullDate(date: Date): string {
  return new Date(date).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Wraps the sanitized email HTML in a minimal document so it renders isolated
// from the dashboard's own CSS — the same reason Gmail itself puts message
// bodies in an iframe. Inline styles and tables from the original email (which
// is how almost every ATS/recruiting email is actually laid out) come through
// untouched; this stylesheet only sets sane defaults for whatever the email
// doesn't already specify.
function buildFrameDoc(html: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8" />
<base target="_blank" />
<style>
  html, body { margin: 0; padding: 16px; font-family: Inter, -apple-system, "Segoe UI", ui-sans-serif, system-ui, sans-serif; font-size: 14px; line-height: 1.6; color: #2D2A26; }
  img { max-width: 100%; height: auto; }
  a { color: #C2662D; }
  table { max-width: 100%; }
</style>
</head><body>${html}</body></html>`;
}

// The dashboard's own font-family/colors don't apply inside an iframe, and
// srcDoc content isn't in the DOM this component controls, so this stays a
// plain uncontrolled iframe rather than trying to sync React state into it.
function EmailHtmlFrame({ html }: { html: string }) {
  return (
    <iframe className="email-frame" sandbox="allow-same-origin allow-popups" srcDoc={buildFrameDoc(html)} title="Email content" />
  );
}

// Click an email in the list, read the whole thing on the right — same pattern as
// any inbox. Filtering by category and picking an email are both client-side state
// over data the server component already fetched, so this is the one interactive
// piece of the dashboard and everything else stays a plain server component.
export function ApplicationsPanel({ applications: rows }: { applications: Row[] }) {
  const [activeTab, setActiveTab] = useState<Tab>("All");
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const counts = useMemo(() => {
    const c: Record<string, number> = { All: rows.length };
    for (const cat of CATEGORIES) c[cat] = 0;
    for (const row of rows) c[row.category] = (c[row.category] ?? 0) + 1;
    return c;
  }, [rows]);

  const filtered = useMemo(
    () => (activeTab === "All" ? rows : rows.filter((row) => row.category === activeTab)),
    [rows, activeTab],
  );

  const selected = filtered.find((row) => row.id === selectedId) ?? null;

  function selectTab(tab: Tab) {
    setActiveTab(tab);
    setSelectedId(null);
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>All applications</h2>
        <div className="tabs">
          {TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              className={`tab ${activeTab === tab ? "active" : ""}`}
              onClick={() => selectTab(tab)}
            >
              {tab} ({counts[tab] ?? 0})
            </button>
          ))}
        </div>
      </div>

      <div className="split-view">
        <div className="split-list">
          {filtered.length === 0 && <div className="empty-state">No emails in this category yet.</div>}
          {filtered.map((row) => (
            <div
              key={row.id}
              className={`split-item ${selected?.id === row.id ? "active" : ""}`}
              onClick={() => setSelectedId(row.id)}
            >
              <div className={avatarClass(row.category)}>{initials(row.company)}</div>
              <div className="split-item-body">
                <div className="split-item-top">
                  <span className="company">{row.company}</span>
                  <span className="date">{formatShortDate(row.receivedAt)}</span>
                </div>
                <div className="role">{row.role ?? row.subject}</div>
                <div className="snippet">{row.snippet}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="split-detail">
          {!selected && <div className="detail-empty">Select an email on the left to read it.</div>}
          {selected && (
            <>
              <div className="detail-head">
                <span className={CATEGORY_BADGE_CLASS[selected.category as Category] ?? "badge applied"}>
                  <span className="dot" />
                  {selected.category}
                </span>
                <h3>{selected.subject ?? "(no subject)"}</h3>
                <div className="detail-meta">
                  <span className="from">{selected.company}</span>
                  {selected.fromEmail ? ` · ${selected.fromEmail}` : ""}
                  {" — "}
                  {formatFullDate(selected.receivedAt)}
                </div>
              </div>
              {selected.bodyHtml ? (
                <EmailHtmlFrame key={selected.id} html={selected.bodyHtml} />
              ) : (
                <div className="detail-body">
                  {selected.body?.trim() || selected.snippet || "No content synced for this email."}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
