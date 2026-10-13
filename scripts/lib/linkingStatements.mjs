// SQL for the application-linking schema change. Kept apart from the runner so a test can
// apply exactly these statements to a legacy-shaped database.
export const STATEMENTS = [
  `ALTER TABLE applications ADD COLUMN IF NOT EXISTS thread_id text`,
  `CREATE INDEX IF NOT EXISTS applications_thread_id_idx ON applications (thread_id)`,
  `ALTER TABLE applications ADD COLUMN IF NOT EXISTS link_state text`,
  `ALTER TABLE applications ADD COLUMN IF NOT EXISTS job_application_id integer`,
  `ALTER TABLE applications ADD COLUMN IF NOT EXISTS link_confidence real`,
  `ALTER TABLE applications ADD COLUMN IF NOT EXISTS link_evidence text`,
  `ALTER TABLE applications ADD COLUMN IF NOT EXISTS link_flagged boolean NOT NULL DEFAULT false`,
  `ALTER TABLE applications ADD COLUMN IF NOT EXISTS interview_round integer`,
  `ALTER TABLE applications ADD COLUMN IF NOT EXISTS extracted_at timestamptz`,
  `ALTER TABLE applications ADD COLUMN IF NOT EXISTS employer text`,
  `ALTER TABLE applications ADD COLUMN IF NOT EXISTS via text`,
  `CREATE INDEX IF NOT EXISTS applications_job_application_id_idx ON applications (job_application_id)`,
  `CREATE TABLE IF NOT EXISTS job_applications (
     id serial PRIMARY KEY,
     employer text NOT NULL,
     role text,
     via text,
     stage text NOT NULL DEFAULT 'Applied',
     interview_round integer NOT NULL DEFAULT 0,
     status text NOT NULL DEFAULT 'open',
     flags text[] NOT NULL DEFAULT '{}',
     applied_at timestamptz,
     first_seen_at timestamptz NOT NULL,
     last_activity_at timestamptz NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  // job_applications may already exist from the first version of this migration.
  `ALTER TABLE job_applications ADD COLUMN IF NOT EXISTS via text`,
  `CREATE TABLE IF NOT EXISTS review_items (
     id serial PRIMARY KEY,
     email_id integer NOT NULL UNIQUE,
     confidence real NOT NULL,
     evidence text NOT NULL,
     candidates jsonb NOT NULL DEFAULT '[]',
     created_at timestamptz NOT NULL DEFAULT now(),
     resolved_at timestamptz
   )`,
  `CREATE TABLE IF NOT EXISTS link_examples (
     id serial PRIMARY KEY,
     kind text NOT NULL,
     email_id integer,
     from_application_id integer,
     to_application_id integer,
     facts jsonb NOT NULL DEFAULT '{}',
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  // Same lockdown as every other table (see secure-database.mjs): Supabase exposes new
  // public tables over PostgREST by default. Row Level Security with no policies denies
  // the anon key everything; the app connects as the owner and bypasses it.
  `ALTER TABLE job_applications ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE review_items ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE link_examples ENABLE ROW LEVEL SECURITY`,
];
