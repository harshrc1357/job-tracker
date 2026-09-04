import { pgTable, serial, text, timestamp, boolean, integer } from "drizzle-orm/pg-core";

// One row per job-related email that made it past classification.
export const applications = pgTable("applications", {
  id: serial("id").primaryKey(),
  gmailMessageId: text("gmail_message_id").notNull().unique(),
  company: text("company").notNull(),
  role: text("role"),
  category: text("category").notNull(), // Applied | Assessment | Interview | Offer | Rejection | Reminder
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
  reminderSent: boolean("reminder_sent").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Single-row table holding the Gmail OAuth refresh token once you've connected an account.
export const googleAuth = pgTable("google_auth", {
  id: serial("id").primaryKey(),
  refreshToken: text("refresh_token").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Bookkeeping for the last sync run — not load-bearing yet, but useful once we move
// from a search query to Gmail's history API for incremental sync.
export const syncState = pgTable("sync_state", {
  id: serial("id").primaryKey(),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull().defaultNow(),
  messagesChecked: integer("messages_checked").notNull().default(0),
});
