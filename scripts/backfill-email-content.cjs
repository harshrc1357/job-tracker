#!/usr/bin/env node
// One-off backfill: rows synced before body/bodyHtml existed only have the
// ~200-char Gmail snippet. This re-fetches each of those messages by its
// already-known gmailMessageId and fills in the real plain-text and sanitized
// HTML bodies, the same way src/app/api/sync/route.ts does for new syncs.
//
// Deliberately plain CommonJS run directly with `node`, not through Next.js —
// it needs no dev server, and importing the actual TS route file here would
// mean fighting the "@/" path-alias resolution for one throw-away run. The
// parsing logic is duplicated from route.ts on purpose: keeping this file
// self-contained means it stays runnable even if that route changes shape
// later, and it's short-lived rather than something to keep in sync forever.
//
// Usage: node scripts/backfill-email-content.cjs

const fs = require("fs");
const path = require("path");

function loadEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) process.env[match[1]] = match[2].replace(/^"|"$/g, "");
  }
}

function decodeBase64Url(data) {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf-8");
}

function findPart(part, mimeType) {
  if (part.mimeType === mimeType && part.body && part.body.data) return part.body.data;
  for (const child of part.parts || []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return null;
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractMessageContent(payload, sanitizeEmailHtml) {
  if (!payload) return { text: "", html: null };

  const plainData = findPart(payload, "text/plain");
  const htmlData = findPart(payload, "text/html");
  const rawHtml = htmlData ? decodeBase64Url(htmlData) : null;

  const text = plainData ? decodeBase64Url(plainData).trim() : rawHtml ? stripHtml(rawHtml) : "";
  const html = rawHtml ? sanitizeEmailHtml(rawHtml) : null;

  return { text, html };
}

// Same allowlist as src/lib/sanitizeEmailHtml.ts — see that file for the reasoning.
function makeSanitizer() {
  const sanitizeHtml = require("sanitize-html");
  return function sanitizeEmailHtml(html) {
    return sanitizeHtml(html, {
      allowedTags: sanitizeHtml.defaults.allowedTags.concat([
        "img",
        "style",
        "font",
        "center",
        "span",
        "div",
        "table",
        "thead",
        "tbody",
        "tr",
        "td",
        "th",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "u",
        "s",
      ]),
      allowedAttributes: {
        "*": [
          "style",
          "class",
          "align",
          "valign",
          "width",
          "height",
          "colspan",
          "rowspan",
          "border",
          "cellpadding",
          "cellspacing",
          "bgcolor",
        ],
        a: ["href", "name", "target", "rel"],
        img: ["src", "alt", "width", "height"],
      },
      allowedSchemes: ["http", "https", "mailto"],
      allowedSchemesByTag: { img: ["http", "https", "data"] },
      transformTags: {
        a: sanitizeHtml.simpleTransform("a", { target: "_blank", rel: "noopener noreferrer" }),
      },
    });
  };
}

async function main() {
  loadEnv();

  const { neon } = require("@neondatabase/serverless");
  const { google } = require("googleapis");
  const sql = neon(process.env.DATABASE_URL);
  const sanitizeEmailHtml = makeSanitizer();

  const [authRow] = await sql`select refresh_token from google_auth limit 1`;
  if (!authRow) {
    console.error("No row in google_auth — Gmail isn't connected. Open /api/auth/google once first.");
    process.exit(1);
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );
  oauth2Client.setCredentials({ refresh_token: authRow.refresh_token });
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  const rows = await sql`select id, gmail_message_id, company from applications where body_html is null`;
  console.log(`${rows.length} row(s) missing body_html.`);

  let updated = 0;
  for (const row of rows) {
    try {
      const full = await gmail.users.messages.get({ userId: "me", id: row.gmail_message_id, format: "full" });
      const { text, html } = extractMessageContent(full.data.payload, sanitizeEmailHtml);
      const body = text || full.data.snippet || "";

      await sql`update applications set body = ${body}, body_html = ${html} where id = ${row.id}`;
      updated++;
      console.log(`  ✓ [${row.id}] ${row.company} — ${html ? "html" : "text-only"}, ${body.length} chars`);
    } catch (err) {
      console.error(`  ✗ [${row.id}] ${row.company} — ${err.message}`);
    }
  }

  console.log(`Done. Updated ${updated}/${rows.length}.`);
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
