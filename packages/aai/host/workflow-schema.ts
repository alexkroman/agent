// Copyright 2026 the AAI authors. MIT license.
/**
 * The journal's SCHEMA: the two tables, the blob table, their indexes, and the
 * `LIVE` status list every claim and settling write is gated on.
 *
 * Split out of `workflow-store.ts` when it reached the 500-line cap, on the seam
 * that was already there — the store is queries over a shape, and this is the
 * shape. Keeping the DDL in one module is also what makes the next column a
 * one-file change rather than a hunt through the query bodies.
 */

/**
 * Statuses a run can still move out of, as a SQL list.
 *
 * Read two ways, and both matter. A claim may only take over a LIVE run, which
 * is what makes a cancelled run stay cancelled. And the three settling writes
 * (`suspend`/`complete`/`fail`) require it too, so a run cancelled while another
 * replica was executing it cannot be resurrected by that replica's terminal
 * write landing afterwards — the work is wasted, the status is not overwritten.
 */
export const LIVE = "('pending', 'sleeping', 'running')";

export const CREATE_RUNS = `create table if not exists aai_workflow_runs (
  run_id text primary key,
  workflow text not null,
  input jsonb,
  status text not null default 'pending',
  output jsonb,
  error text,
  correlation_key text,
  wake_at timestamptz,
  lease_until timestamptz,
  steps_completed int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)`;

/**
 * Add `correlation_key` to a table created before it existed.
 *
 * `init()` is `create table if not exists`, so an app whose journal predates
 * this column would keep the old shape forever and every `start({ key })` would
 * fail on an unknown column. Idempotent, so it costs a no-op statement per
 * engine rather than a migration mechanism this package does not have.
 */
export const ADD_RUNS_KEY =
  "alter table aai_workflow_runs add column if not exists correlation_key text";

export const CREATE_STEPS = `create table if not exists aai_workflow_steps (
  run_id text not null references aai_workflow_runs(run_id) on delete cascade,
  step_id text not null,
  output jsonb,
  seq bigserial not null,
  created_at timestamptz not null default now(),
  primary key (run_id, step_id)
)`;

/**
 * Uploads a run works on, kept out of the journal (see
 * {@link WorkflowStore.putBlob}). Not a child of `aai_workflow_runs`: a blob is
 * written BEFORE the run that names it exists, so a foreign key would reject
 * every upload.
 */
export const CREATE_BLOBS = `create table if not exists aai_workflow_blobs (
  blob_id text primary key,
  content_type text not null,
  data text not null,
  bytes int not null,
  created_at timestamptz not null default now()
)`;

/** For the age sweep — without it pruning scans every blob ever uploaded. */
export const CREATE_BLOBS_INDEX = `create index if not exists aai_workflow_blobs_created
  on aai_workflow_blobs (created_at)`;

/**
 * Partial index over exactly the rows {@link WorkflowStore.due} scans. Without
 * it that query is a full scan of every run the app has ever made, run on a
 * timer — and completed runs are kept (they are the run history a UI reads),
 * so the table only grows.
 */
export const CREATE_DUE_INDEX = `create index if not exists aai_workflow_runs_due
  on aai_workflow_runs (wake_at, lease_until)
  where status in ('pending', 'sleeping', 'running')`;

/**
 * Index behind {@link WorkflowStore.findByKey}. Partial over rows that HAVE a
 * key, because most runs do not — an unkeyed run is started by a page that holds
 * its own `runId`, and indexing those nulls would cost every insert for a lookup
 * nothing can perform.
 */
export const CREATE_KEY_INDEX = `create index if not exists aai_workflow_runs_key
  on aai_workflow_runs (workflow, correlation_key, created_at desc)
  where correlation_key is not null`;

/**
 * Index behind {@link WorkflowStore.recent}. NOT partial, unlike the key index
 * below it: this read exists to answer for runs that carry no key, so the
 * `where correlation_key is not null` that makes that one cheap would exclude
 * exactly the rows this one is for.
 */
export const CREATE_WORKFLOW_INDEX = `create index if not exists aai_workflow_runs_workflow
  on aai_workflow_runs (workflow, created_at desc)`;

/**
 * How many continuations deep this run is (`ctx.continueAs`).
 *
 * A column rather than a counter in the author's input, which is theirs. It exists
 * because an unconditional `continueAs` is an INFINITE chain of runs that bills
 * forever, and it is easy to write — the first draft of this feature's own test did
 * it. `MAX_CONTINUATIONS` is what turns that into a failed run naming the cause.
 */
export const ADD_CONTINUATION_DEPTH =
  "alter table aai_workflow_runs add column if not exists continuation_depth int not null default 0";

/** Table recording which migrations this schema has run. */
export const CREATE_MIGRATIONS = `create table if not exists aai_workflow_migrations (
  id text primary key,
  applied_at timestamptz not null default now()
)`;

/** Record one migration as applied. Concurrency-safe: two booting sandboxes race. */
export const RECORD_MIGRATION =
  "insert into aai_workflow_migrations (id) values ($1) on conflict (id) do nothing";

/** Ids already applied, so `init()` runs only what is missing. */
export const SELECT_MIGRATIONS = "select id from aai_workflow_migrations";

/**
 * The journal's migrations, in order, each applied ONCE.
 *
 * This replaced running every `create … if not exists` on every boot. That was
 * idempotent and therefore looked free, and it was not: Postgres raises a NOTICE
 * for each no-op, so a healthy app logged six or seven per engine into a log the
 * guest relays to the platform — and the `alter table … add column if not exists`
 * one (`42701`, duplicate_column) was missed by the driver's notice filter for a
 * while, which is what made the cost visible. Nothing re-running means nothing to
 * filter.
 *
 * **Every statement stays individually idempotent even so**, and that is not
 * belt-and-braces — it is required. Apps deployed before this table existed
 * already have the tables and no record of them, so `0001` and `0002` WILL run
 * against a populated schema exactly once, and must be no-ops there rather than
 * errors. A migration added later may drop the `if not exists` only if it can
 * never meet a schema that already has it, which for a shipped SDK is never.
 *
 * Order matters: the steps table's foreign key needs the runs table, and every
 * index needs its own table. Append only — an id that has been released is a
 * fact about somebody's database.
 */
export const MIGRATIONS: readonly { id: string; sql: string }[] = [
  { id: "0001-runs", sql: CREATE_RUNS },
  { id: "0002-correlation-key", sql: ADD_RUNS_KEY },
  { id: "0003-steps", sql: CREATE_STEPS },
  { id: "0004-due-index", sql: CREATE_DUE_INDEX },
  { id: "0005-workflow-index", sql: CREATE_WORKFLOW_INDEX },
  { id: "0006-key-index", sql: CREATE_KEY_INDEX },
  { id: "0007-blobs", sql: CREATE_BLOBS },
  { id: "0008-blobs-index", sql: CREATE_BLOBS_INDEX },
  { id: "0009-continuation-depth", sql: ADD_CONTINUATION_DEPTH },
];
