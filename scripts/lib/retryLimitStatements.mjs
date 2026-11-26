// SQL for the retry-limit table (message_failures in src/db/schema.ts). Kept apart from
// the runner so a test can apply exactly these statements. Additive and idempotent.
export const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS message_failures (
     gmail_message_id text PRIMARY KEY,
     failures integer NOT NULL DEFAULT 0,
     last_error text,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
];
