import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";

// Deliberately doesn't throw at import time: Next.js resolves this module graph eagerly,
// and a hard throw here would take down every page, including ones that don't touch the
// DB, before Elon has had a chance to set DATABASE_URL post-deploy. Actual queries against
// the placeholder will fail with a clear error, which callers (page.tsx, /api/sync) catch
// and turn into a "not configured yet" message instead of a crash.
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.warn("[db] DATABASE_URL is not set — copy .env.example to .env.local and fill it in.");
}

const sql = neon(connectionString ?? "postgres://user:pass@localhost:5432/unconfigured");
export const db = drizzle(sql);
export const isDbConfigured = Boolean(connectionString);
