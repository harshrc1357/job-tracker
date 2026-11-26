import fs from "node:fs";
import path from "node:path";

// The connection string for the tests that write to a real Postgres (RUN_DB_TESTS=1).
//
// They used to run against DATABASE_URL, which is production. One inserts a due Interview
// row that the 5-minute cron can send a Telegram reminder for before the test deletes it;
// another rewrites sync_state. So they now need a database of their own, named
// TEST_DATABASE_URL, and refuse to start when it is missing or is the production one.
type Env = Record<string, string | undefined>;

export function testDatabaseUrl(env: Env = withDotEnv()): string {
  const url = env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error("RUN_DB_TESTS=1 needs TEST_DATABASE_URL: a database you can write test rows to, never production.");
  }
  if (url === env.DATABASE_URL || url === env.DIRECT_URL) {
    throw new Error("TEST_DATABASE_URL is the production database. Point it at a separate database.");
  }
  return url;
}

// process.env with .env filled in underneath it, so a value set in the shell wins.
function withDotEnv(): Env {
  const merged: Env = {};
  const envPath = path.join(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (match) merged[match[1]] = match[2].trim();
    }
  }
  return { ...merged, ...process.env };
}
