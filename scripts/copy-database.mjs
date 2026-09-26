// Copies every row from one Postgres to another. Written for the Neon -> Supabase move
// but provider-agnostic: it only speaks standard SQL.
//
// Safe to re-run. Every insert is ON CONFLICT DO NOTHING against the table's real
// unique constraint, so a run that dies halfway can simply be run again and will skip
// what already landed. Nothing is ever deleted from either side, and the source is
// only ever read.
//
// Usage (from the project root):
//   node scripts/copy-database.mjs --dry-run
//   node scripts/copy-database.mjs
//
// Reads SOURCE_DATABASE_URL and TARGET_DATABASE_URL from the environment or .env.

import { readFileSync } from "node:fs";
import postgres from "postgres";

// Order matters only in that nothing here has foreign keys between tables. Listed
// explicitly rather than discovered, so a stray table cannot be dragged along.
const TABLES = [
  { name: "applications", conflict: "gmail_message_id" },
  { name: "ignored_messages", conflict: "gmail_message_id" },
  { name: "google_auth", conflict: null },
  { name: "llm_usage", conflict: "day, model" },
  { name: "sync_state", conflict: null },
];

const BATCH_SIZE = 500;

function loadEnvFile(path = ".env") {
  try {
    const text = readFileSync(path, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key] !== undefined) continue;
      process.env[key] = rawValue.trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // No .env is fine when the values come from the real environment.
  }
}

function connect(url, label) {
  if (!url) {
    console.error(`Missing ${label}. Set it in .env or the environment.`);
    process.exit(1);
  }
  return postgres(url, { max: 1, prepare: false, connect_timeout: 20, idle_timeout: 10 });
}

async function copyTable(source, target, { name, conflict }, isDryRun) {
  const rows = await source`select * from ${source(name)}`;
  if (rows.length === 0) {
    console.log(`  ${name}: source is empty, nothing to copy`);
    return { read: 0, written: 0 };
  }

  const before = await countRows(target, name);
  if (isDryRun) {
    console.log(`  ${name}: would copy ${rows.length} rows (target currently has ${before})`);
    return { read: rows.length, written: 0 };
  }

  const columns = Object.keys(rows[0]);
  for (let index = 0; index < rows.length; index += BATCH_SIZE) {
    const batch = rows.slice(index, index + BATCH_SIZE);
    // The id column is carried across deliberately. The dashboard does not expose ids,
    // but keeping them means a half-finished run and a rerun cannot produce duplicate
    // rows under different ids.
    if (conflict) {
      await target`
        insert into ${target(name)} ${target(batch, columns)}
        on conflict (${target.unsafe(conflict)}) do nothing
      `;
    } else {
      await target`
        insert into ${target(name)} ${target(batch, columns)}
        on conflict (id) do nothing
      `;
    }
  }

  const after = await countRows(target, name);
  console.log(`  ${name}: read ${rows.length}, target went ${before} -> ${after}`);
  return { read: rows.length, written: after - before };
}

async function countRows(sql, name) {
  const [row] = await sql`select count(*)::int as n from ${sql(name)}`;
  return row.n;
}

// Every id column is a serial. Copying explicit ids leaves the sequence behind, so the
// next insert collides on the primary key. Nothing catches that until the first real
// sync after the move, which is the worst possible time to find out.
async function resyncSequences(target, isDryRun) {
  console.log("\nResyncing id sequences:");
  for (const { name } of TABLES) {
    if (isDryRun) {
      console.log(`  ${name}: would resync`);
      continue;
    }
    await target.unsafe(`
      select setval(
        pg_get_serial_sequence('${name}', 'id'),
        coalesce((select max(id) from ${name}), 0) + 1,
        false
      )
    `);
    console.log(`  ${name}: done`);
  }
}

async function main() {
  loadEnvFile();
  const isDryRun = process.argv.includes("--dry-run");

  const source = connect(process.env.SOURCE_DATABASE_URL, "SOURCE_DATABASE_URL");
  const target = connect(process.env.TARGET_DATABASE_URL, "TARGET_DATABASE_URL");

  console.log(isDryRun ? "DRY RUN — nothing will be written\n" : "Copying\n");

  try {
    await source`select 1`;
    await target`select 1`;
  } catch (error) {
    console.error("Could not reach both databases:", error.message);
    await source.end();
    await target.end();
    process.exit(1);
  }

  const totals = { read: 0, written: 0 };
  try {
    for (const table of TABLES) {
      const result = await copyTable(source, target, table, isDryRun);
      totals.read += result.read;
      totals.written += result.written;
    }
    await resyncSequences(target, isDryRun);
    console.log(`\nRead ${totals.read} rows, wrote ${totals.written}.`);
  } catch (error) {
    console.error("\nFailed:", error.message);
    console.error("Nothing was deleted. Fix the cause and run again — inserts skip what already landed.");
    process.exitCode = 1;
  } finally {
    await source.end();
    await target.end();
  }
}

await main();
