// Closes the PostgREST attack surface that Supabase opens by default.
//
// Supabase grants its `anon` and `authenticated` roles full DML on every table in
// `public`, and exposes them over PostgREST at https://<ref>.supabase.co/rest/v1/.
// That is a sensible default for an app built AROUND PostgREST, where Row Level
// Security is the access control and the anon key is meant to be public.
//
// This app is not built that way. It connects as `postgres` over a direct Postgres
// connection and does its own authorization in middleware. PostgREST is pure attack
// surface here: nothing uses it, and with RLS off it let anyone holding the anon key
// (a value designed to ship in browsers) read every email body and the Gmail refresh
// token in google_auth, or TRUNCATE the lot.
//
// Two independent layers, because either one alone has a failure mode:
//
//   1. REVOKE  - removes the privilege outright. Defeated if something later runs a
//                GRANT, which Supabase tooling and `drizzle-kit push` can both do.
//   2. RLS     - denies every row to every non-owner role when no policy exists.
//                Survives a stray GRANT. Does not affect the app: `postgres` owns
//                these tables and table owners bypass RLS unless FORCE is set.
//
// Deliberately NO policies are created. A table with RLS enabled and zero policies
// denies everything, which is exactly right for tables that must never be reachable
// from a browser.
//
// service_role keeps its grants: it bypasses RLS by design and is the escape hatch for
// the Supabase dashboard's own table editor. Its key is secret and server-only.
//
// Safe to re-run. Every statement is idempotent.
//
// Usage:  node scripts/secure-database.mjs [--check]

import { readFileSync } from "node:fs";
import postgres from "postgres";

// Every table the app owns. Listed explicitly rather than discovered so a table that
// genuinely SHOULD be public later has to be removed from this list on purpose.
const TABLES = ["applications", "google_auth", "ignored_messages", "job_applications", "llm_usage", "review_items", "sync_state"];

// The two roles PostgREST authenticates as. service_role is omitted on purpose.
const PUBLIC_ROLES = ["anon", "authenticated"];

function loadEnv(path = ".env") {
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!match || process.env[match[1]] !== undefined) continue;
      process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // Values may come from the real environment instead.
  }
}

async function report(sql) {
  const rows = await sql`
    select
      t.tablename,
      t.rowsecurity as rls,
      coalesce((
        select string_agg(distinct g.grantee, ',' order by g.grantee)
        from information_schema.role_table_grants g
        where g.table_schema = 'public'
          and g.table_name = t.tablename
          and g.grantee in ('anon', 'authenticated', 'PUBLIC')
      ), '(none)') as exposed_to
    from pg_tables t
    where t.schemaname = 'public'
    order by t.tablename
  `;
  console.table(rows.map((r) => ({ table: r.tablename, rls: r.rls, exposedTo: r.exposed_to })));
  return rows;
}

async function main() {
  loadEnv();
  const isCheckOnly = process.argv.includes("--check");

  // Session pooler, not the transaction pooler: DDL and GRANT need a stable backend.
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error("Set DIRECT_URL (preferred) or DATABASE_URL.");
    process.exit(1);
  }

  const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 20 });

  try {
    console.log("Before:");
    await report(sql);

    if (isCheckOnly) {
      console.log("\n--check: nothing was changed.");
      return;
    }

    for (const table of TABLES) {
      for (const role of PUBLIC_ROLES) {
        await sql.unsafe(`revoke all privileges on table public.${table} from ${role}`);
      }
      // PUBLIC is every role including future ones. Supabase does not grant it by
      // default, but revoking costs nothing and closes the gap if something does.
      await sql.unsafe(`revoke all privileges on table public.${table} from public`);
      await sql.unsafe(`alter table public.${table} enable row level security`);
    }

    // Sequences too. A role that cannot read the table but can read its id sequence
    // still leaks row counts, which for an inbox is a signal about activity.
    for (const role of PUBLIC_ROLES) {
      await sql.unsafe(`revoke all on all sequences in schema public from ${role}`);
    }

    // Future tables. Without this, the next `drizzle-kit push` creates a table that
    // inherits Supabase's default grants and silently reopens exactly this hole.
    for (const role of PUBLIC_ROLES) {
      await sql.unsafe(
        `alter default privileges in schema public revoke all on tables from ${role}`
      );
      await sql.unsafe(
        `alter default privileges in schema public revoke all on sequences from ${role}`
      );
    }

    console.log("\nAfter:");
    const after = await report(sql);

    const stillOpen = after.filter((r) => !r.rls || r.exposed_to !== "(none)");
    if (stillOpen.length > 0) {
      console.error("\nFAILED: still exposed ->", stillOpen.map((r) => r.tablename).join(", "));
      process.exitCode = 1;
      return;
    }
    console.log("\nAll tables: RLS enabled, no grants to anon or authenticated.");
  } catch (error) {
    console.error("Failed:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

await main();
process.exit(process.exitCode ?? 0);
