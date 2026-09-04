import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy — Job Tracker",
};

// Required to exist and be accurate for two reasons: it's the URL Google's OAuth
// consent screen links to once this app is published, and it's what Search
// Console fetches to verify domain ownership. Public on purpose (see the
// /privacy exclusion in middleware.ts) — those two things can't go through a
// Google-login wall.
export default function PrivacyPolicyPage() {
  return (
    <div style={{ maxWidth: 680, margin: "64px auto", lineHeight: 1.7 }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>Privacy Policy</h1>
      <p style={{ color: "var(--ink-soft)", fontSize: 13, marginBottom: 32 }}>Last updated September 2026</p>

      <p style={{ marginBottom: 20 }}>
        Job Tracker is a single-user personal tool. It has exactly one account holder, and access to the
        dashboard is restricted to that one Google account. It is not a public product and does not accept
        other users.
      </p>

      <h2 style={{ fontSize: 16, fontWeight: 600, marginTop: 28, marginBottom: 8 }}>What it accesses</h2>
      <p style={{ marginBottom: 20 }}>
        With the account holder&apos;s Google OAuth consent, this app reads Gmail messages (read-only —
        it never sends, deletes, or modifies anything in Gmail) to find job-application-related emails:
        application confirmations, assessments, interview invitations, offers, and rejections. It does not
        read or store any email outside that category.
      </p>

      <h2 style={{ fontSize: 16, fontWeight: 600, marginTop: 28, marginBottom: 8 }}>What it stores</h2>
      <p style={{ marginBottom: 20 }}>
        For each matching email: sender, subject, company name, category, received date, and the message
        body (used to display the email in the dashboard). This is stored in a private database only the
        account holder can query, and is never shared, sold, or made public.
      </p>

      <h2 style={{ fontSize: 16, fontWeight: 600, marginTop: 28, marginBottom: 8 }}>Third parties involved</h2>
      <p style={{ marginBottom: 20 }}>
        Email subject lines and short snippets are sent to Groq&apos;s LLM API solely to classify which
        pipeline stage an email belongs to (applied / assessment / interview / offer / rejection). Reminder
        notifications are sent to the account holder&apos;s own Telegram account. No data is sold, shared with
        advertisers, or used for anything beyond running this tool for its one user.
      </p>

      <h2 style={{ fontSize: 16, fontWeight: 600, marginTop: 28, marginBottom: 8 }}>Revoking access</h2>
      <p>
        The account holder can revoke this app&apos;s access to their Google account at any time from{" "}
        <a href="https://myaccount.google.com/permissions" style={{ color: "var(--coral)" }}>
          Google Account → Security → Third-party access
        </a>
        , which immediately stops all Gmail access.
      </p>
    </div>
  );
}
