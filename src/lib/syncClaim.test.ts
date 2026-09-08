import { afterAll, beforeAll, describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";

// The throttle is the only thing that makes /api/sync safe to expose without a
// secret, so it gets tested against the real database rather than a mock. Whether
// two concurrent conditional UPDATEs can both win is a question about Postgres.
//
//   RUN_DB_TESTS=1 npx vitest run src/lib/syncClaim.test.ts
//
// Saves and restores the real sync_state timestamp, so running it does not cause the
// next production sync to be skipped.

const LIVE = process.env.RUN_DB_TESTS === "1";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let claimSyncSlot: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sql: any;
let savedLastSyncedAt: Date | null = null;

const MIN_INTERVAL_MS = 4 * 60 * 1000;

beforeAll(async () => {
  if (!LIVE) return;
  loadEnv();
  const { neon } = await import("@neondatabase/serverless");
  sql = neon(process.env.DATABASE_URL!);
  ({ claimSyncSlot } = await import("./syncClaim"));

  const [row] = await sql`SELECT last_synced_at FROM sync_state WHERE id = 1`;
  savedLastSyncedAt = row ? row.last_synced_at : null;
});

afterAll(async () => {
  if (!LIVE || !sql) return;
  if (savedLastSyncedAt) {
    await sql`UPDATE sync_state SET last_synced_at = ${savedLastSyncedAt} WHERE id = 1`;
  }
});

describe.skipIf(!LIVE)("claimSyncSlot", () => {
  test("lets a caller through when the last sync is old enough", async () => {
    // Arrange
    await sql`UPDATE sync_state SET last_synced_at = now() - interval '1 hour' WHERE id = 1`;

    // Act
    const outcome = await claimSyncSlot();

    // Assert
    expect(outcome).toEqual({ claimed: true });
  });

  test("refuses a second caller immediately afterwards", async () => {
    // Arrange: the claim above just stamped the row, so this is the "someone is
    // hammering the public endpoint" case.
    const outcome = await claimSyncSlot();

    // Assert
    expect(outcome).toEqual({ claimed: false, reason: "too-soon" });
  });

  test("only one of many simultaneous callers wins", async () => {
    // Arrange: this is the property the whole design rests on. Twenty requests
    // arriving in the same instant must produce exactly one sync.
    await sql`UPDATE sync_state SET last_synced_at = now() - interval '1 hour' WHERE id = 1`;

    // Act
    const outcomes = await Promise.all(Array.from({ length: 20 }, () => claimSyncSlot()));

    // Assert
    expect(outcomes.filter((o: { claimed: boolean }) => o.claimed)).toHaveLength(1);
  });

  test("lets the next legitimate cron tick through once the interval has passed", async () => {
    // Arrange: a 5-minute cron against a 4-minute floor. The gap exists so ordinary
    // scheduler jitter never rejects a real tick.
    const justOverInterval = new Date(Date.now() - MIN_INTERVAL_MS - 1_000);
    await sql`UPDATE sync_state SET last_synced_at = ${justOverInterval} WHERE id = 1`;

    // Act
    const outcome = await claimSyncSlot();

    // Assert
    expect(outcome.claimed).toBe(true);
  });

  test("blocks a tick that arrives early, inside the interval", async () => {
    // Arrange
    const insideInterval = new Date(Date.now() - MIN_INTERVAL_MS + 30_000);
    await sql`UPDATE sync_state SET last_synced_at = ${insideInterval} WHERE id = 1`;

    // Act
    const outcome = await claimSyncSlot();

    // Assert
    expect(outcome).toEqual({ claimed: false, reason: "too-soon" });
  });
});

function loadEnv() {
  const envPath = path.join(process.cwd(), ".env");
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
}
