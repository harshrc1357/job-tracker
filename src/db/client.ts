import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

// postgres-js over plain TCP rather than a vendor-specific HTTP driver.
//
// This used to be @neondatabase/serverless + drizzle-orm/neon-http, which works only
// against Neon. Neon's free tier meters COMPUTE HOURS (191.9/month), and a cron that
// runs often enough never lets the compute autosuspend, so the allowance is gone in
// about a week and every query starts returning HTTP 402. Storage was never the
// problem — the database is 37 MB against a 0.5 GB limit.
//
// postgres-js speaks the standard wire protocol, so the same code runs against Neon,
// Supabase, Aiven or a local postgres. Moving providers is a connection string, not a
// rewrite, and that is the actual point: the provider is no longer load-bearing.
const connectionString = process.env.DATABASE_URL;

// Deliberately doesn't throw at import time: Next.js resolves this module graph eagerly,
// and a hard throw here would take down every page, including ones that don't touch the
// DB, before Elon has had a chance to set DATABASE_URL post-deploy. Actual queries against
// the placeholder will fail with a clear error, which callers (page.tsx, /api/sync) catch
// and turn into a "not configured yet" message instead of a crash.
if (!connectionString) {
  console.warn("[db] DATABASE_URL is not set — copy .env.example to .env and fill it in.");
}

// Serverless settings, and each one is load-bearing on Vercel:
//
// max: 1        — a lambda handles one request at a time, so a pool is wasted
//                 connections against Supabase's pooler limit.
// prepare: false — required by Supabase's transaction-mode pooler (port 6543), which
//                 multiplexes statements across backends and cannot hold a prepared
//                 statement open. Harmless on Neon and on a direct connection.
// idle_timeout  — let the socket die rather than hold it open across a frozen lambda.
const client = postgres(connectionString ?? "postgres://user:pass@localhost:5432/unconfigured", {
  max: 1,
  prepare: false,
  idle_timeout: 20,
  connect_timeout: 15,
});

export const db = drizzle(client);
export const isDbConfigured = Boolean(connectionString);
