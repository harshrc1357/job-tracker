import {
  pgTable,
  serial,
  text,
  timestamp,
  boolean,
  integer,
  real,
  jsonb,
  unique,
} from "drizzle-orm/pg-core";

// One row per job-related email that made it past classification.
export const applications = pgTable("applications", {
  id: serial("id").primaryKey(),
  gmailMessageId: text("gmail_message_id").notNull().unique(),
  // Gmail thread id. ATS systems reply in-thread, so a thread already linked to an
  // application is the strongest evidence for linking the next email (see src/lib/link).
  // Nullable: rows stored before this column existed are filled by scripts/backfill-thread-id.mts.
  threadId: text("thread_id"),
  company: text("company").notNull(),
  role: text("role"),
  // Applied | Assessment | Interview | Offer | Rejection | Reminder | Verification
  category: text("category").notNull(),
  subject: text("subject"),
  snippet: text("snippet"),
  // Plain-text fallback (the text/plain part, or HTML with tags stripped if that's
  // all the sender sent) — used only when bodyHtml isn't available.
  body: text("body"),
  // Sanitized text/html part, decoded from Gmail as-is (fonts, links, spacing,
  // logos) and rendered in a sandboxed iframe so the dashboard shows the email
  // the way Gmail does, not a flattened wall of text. Sanitized at sync time with
  // sanitize-html (src/lib/sanitizeEmailHtml.ts) — scripts and event handlers are
  // stripped before this ever reaches the database.
  bodyHtml: text("body_html"),
  fromEmail: text("from_email"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  reminderDueAt: timestamp("reminder_due_at", { withTimezone: true }),
  // Reminders repeat rather than fire once: every REMINDER_INTERVAL_HOURS until
  // MAX_REMINDERS_PER_APPLICATION is hit or the event passes.
  // - reminderCount  how many have gone out so far (hard cap enforced against this)
  // - lastReminderAt when the last one went out, so the cron can space them
  // - reminderSent   the loop is finished for this row: cap reached, or due date
  //                  passed. Kept as the single "stop asking" flag so the query
  //                  can skip finished rows cheaply.
  // Why this row got the category it did. Not load-bearing — the dashboard never
  // reads them — but a misclassification is otherwise unfalsifiable after the fact:
  // you cannot tell a prompt regression from a genuinely ambiguous email without
  // knowing which model answered and what text it pointed at.
  classifiedBy: text("classified_by"),
  classifierEvidence: text("classifier_evidence"),
  // How this email was linked to a job application (see src/lib/link and GLOSSARY.md).
  // null link_state = not processed yet; that is what makes linking idempotent.
  //   linked  attached to job_application_id
  //   review  the linker would not decide; a row in review_items waits for the owner
  //   ignored never part of an application (verification, own reply with no match)
  linkState: text("link_state"),
  jobApplicationId: integer("job_application_id"),
  linkConfidence: real("link_confidence"),
  linkEvidence: text("link_evidence"),
  linkFlagged: boolean("link_flagged").notNull().default(false),
  // Interview round when the email stated one (extracted by the classifier).
  interviewRound: integer("interview_round"),
  // When employer/role/round were extracted by the classifier. null on rows stored before
  // that existed; scripts/link-history.mts re-extracts those before linking them.
  extractedAt: timestamp("extracted_at", { withTimezone: true }),
  reminderCount: integer("reminder_count").notNull().default(0),
  lastReminderAt: timestamp("last_reminder_at", { withTimezone: true }),
  reminderSent: boolean("reminder_sent").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// One row per attempt at one Role at one Employer (GLOSSARY.md: Application). The
// legacy table above is misnamed: it stores Emails, and each points here through
// job_application_id. Renaming it is a wide refactor, deliberately left for later.
export const jobApplications = pgTable("job_applications", {
  id: serial("id").primaryKey(),
  // The real employer, never the ATS.
  employer: text("employer").notNull(),
  role: text("role"),
  // Applied | Screening | Assessment | Interview | Offer
  stage: text("stage").notNull().default("Applied"),
  interviewRound: integer("interview_round").notNull().default(0),
  // open | rejected. Rejected keeps the stage it reached.
  status: text("status").notNull().default("open"),
  // e.g. reopened, offer-rescinded
  flags: text("flags").array().notNull().default([]),
  // null when we only ever saw later-stage mail (Applied email never arrived).
  appliedAt: timestamp("applied_at", { withTimezone: true }),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Every correction the owner makes (detach, split, merge, review answer, stage change),
// kept as a labelled example of what the right link was. Nothing reads it yet; it is the
// ground truth the linker's thresholds and prompts get measured against.
export const linkExamples = pgTable("link_examples", {
  id: serial("id").primaryKey(),
  // detach | split | merge | review | stage
  kind: text("kind").notNull(),
  emailId: integer("email_id"),
  fromApplicationId: integer("from_application_id"),
  toApplicationId: integer("to_application_id"),
  // What the linker saw at the time: employer, role, thread, confidence, evidence.
  facts: jsonb("facts").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Emails the linker would not decide (confidence < 0.70), waiting for one tap.
export const reviewItems = pgTable("review_items", {
  id: serial("id").primaryKey(),
  emailId: integer("email_id").notNull().unique(),
  confidence: real("confidence").notNull(),
  evidence: text("evidence").notNull(),
  // [{ applicationId, score }]
  candidates: jsonb("candidates").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

// Message ids the classifier has already judged to be not job-related.
//
// Without this, every non-job email inside the lookback window gets re-fetched and
// re-classified on every run, forever — 323 wasted LLM calls per run against a free
// tier of 250 per DAY, which burned the quota permanently and meant real job mail
// stopped being classified at all. A skip is a decision worth keeping.
export const ignoredMessages = pgTable("ignored_messages", {
  id: serial("id").primaryKey(),
  gmailMessageId: text("gmail_message_id").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Single-row table holding the Gmail OAuth refresh token once you've connected an account.
export const googleAuth = pgTable("google_auth", {
  id: serial("id").primaryKey(),
  refreshToken: text("refresh_token").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// How many LLM calls each model has made on a given day, in the OWNER's local
// timezone (see llm/dailyUsage.ts for why not UTC).
//
// The per-minute token bucket lives in memory and is correctly thrown away with the
// process. A per-DAY ceiling cannot: a serverless run that starts from zero on every
// invocation has no ceiling at all, which is how a previous provider's entire daily
// quota was drained in a single run and every later run failed outright.
export const llmUsage = pgTable(
  "llm_usage",
  {
    id: serial("id").primaryKey(),
    // YYYY-MM-DD, owner-local. Text rather than date so it compares as a plain
    // string and carries no timezone of its own.
    day: text("day").notNull(),
    // OpenRouter model slug, e.g. google/gemini-2.5-flash-lite.
    model: text("model").notNull(),
    calls: integer("calls").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // The upsert target. Without it two overlapping runs insert two rows for the
    // same day and the cap silently doubles.
    dayModel: unique("llm_usage_day_model").on(table.day, table.model),
  })
);

// Bookkeeping for the last sync run — not load-bearing yet, but useful once we move
// from a search query to Gmail's history API for incremental sync.
export const syncState = pgTable("sync_state", {
  id: serial("id").primaryKey(),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull().defaultNow(),
  messagesChecked: integer("messages_checked").notNull().default(0),
});
