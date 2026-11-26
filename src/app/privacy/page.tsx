import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy — Job Tracker",
};

const USER_DATA_POLICY_URL = "https://developers.google.com/terms/api-services-user-data-policy";
const WORKSPACE_POLICY_URL = "https://developers.google.com/workspace/workspace-api-user-data-developer-policy";

const headingStyle = { fontSize: 16, fontWeight: 600, marginTop: 28, marginBottom: 8 } as const;
const paragraphStyle = { marginBottom: 20 } as const;
const linkStyle = { color: "var(--coral)" } as const;

// Required to exist and be accurate for two reasons: it's the URL Google's OAuth
// consent screen links to once this app is published, and it's what Search
// Console fetches to verify domain ownership. Public on purpose (see the
// /privacy exclusion in middleware.ts) — those two things can't go through a
// Google-login wall.
//
// Google's API Services User Data Policy requires this page to match what the code
// does. When the classifier's provider, the fields it receives, or what is stored
// changes, this page changes in the same commit.
export default function PrivacyPolicyPage() {
  return (
    <div style={{ maxWidth: 680, margin: "64px auto", lineHeight: 1.7 }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>Privacy Policy</h1>
      <p style={{ color: "var(--ink-soft)", fontSize: 13, marginBottom: 32 }}>Last updated October 2026</p>

      <p style={paragraphStyle}>
        Job Tracker is a single-user personal tool. It has exactly one account holder, and access to the
        dashboard is restricted to that one Google account. It is not a public product and does not accept
        other users.
      </p>

      <h2 style={headingStyle}>What it accesses</h2>
      <p style={paragraphStyle}>
        With the account holder&apos;s Google OAuth consent, this app reads Gmail messages (read-only —
        it never sends, deletes, or modifies anything in Gmail). It only fetches recent messages (the last 60
        days by default) that match a job-related search, for example messages that mention an application, interview,
        assessment, offer, recruiter, or verification code. Each fetched message is read to decide whether it
        belongs to a job application.
      </p>

      <h2 style={headingStyle}>What it stores</h2>
      <p style={paragraphStyle}>
        For each job-related email: sender, subject, company name, category, received date, any due date, and
        the message body (used to display the email in the dashboard). For a fetched email that is not
        job-related, it stores only the Gmail message id, so that the email is not read again. This data is
        kept in a private hosted Postgres database that only the account holder can query. It is never
        shared, sold, or made public.
      </p>

      <h2 style={headingStyle}>Third parties involved</h2>
      <p style={paragraphStyle}>
        To classify each fetched email, the app sends its sender, recipients, subject, and up to 5,000
        characters of its body to OpenRouter, which passes the request to Google&apos;s Gemini model or, if
        that is unavailable, to OpenAI&apos;s GPT model. Every request tells OpenRouter to use only providers
        that do not collect the request or use it to train models. The answer is used only to sort the email
        into a pipeline stage (applied / assessment / interview / offer / rejection) and to find due dates.
      </p>
      <p style={paragraphStyle}>
        Reminder and new-email notifications, with the company name and subject, are sent to the account
        holder&apos;s own Telegram account. No data is sold, shared with advertisers, or used for anything
        beyond running this tool for its one user.
      </p>

      <h2 style={headingStyle}>Google API data and Limited Use</h2>
      <p style={paragraphStyle}>
        Job Tracker&apos;s use and transfer to any other app of information received from Google APIs will
        adhere to the{" "}
        <a href={USER_DATA_POLICY_URL} style={linkStyle}>
          Google API Services User Data Policy
        </a>
        , including the Limited Use requirements, and to the{" "}
        <a href={WORKSPACE_POLICY_URL} style={linkStyle}>
          Google Workspace API User Data and Developer Policy
        </a>
        . Gmail data is used only for the features shown in this app. It is not used to train or improve any
        AI or machine learning model, and no person other than the account holder reads it.
      </p>

      <h2 style={headingStyle}>Revoking access</h2>
      <p>
        The account holder can revoke this app&apos;s access to their Google account at any time from{" "}
        <a href="https://myaccount.google.com/permissions" style={linkStyle}>
          Google Account → Security → Third-party access
        </a>
        , which immediately stops all Gmail access.
      </p>
    </div>
  );
}
