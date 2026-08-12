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
