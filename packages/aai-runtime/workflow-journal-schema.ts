// Copyright 2026 the AAI authors. MIT license.
/**
 * The workflow journal's SCHEMA: the five table names, their DDL, and the
 * best-effort boot call that applies it.
 *
 * Split from `workflow-journal-postgres.ts` at the seam that file already had.
 * The store is a set of statements over these tables and never reasons about
 * their shape, so the two halves share only the names — which is also what
 * makes this the half other packages import: `aai-server` needs the table names
 * to declare them in a real migration, and needs none of the query bodies.
 *
 * {@link workflowJournalDdl} is the shape and whoever OWNS the database applies
 * it; {@link applyWorkflowJournalDdl} is the best-effort boot call for the two
 * operators who own their database and had no other way to act on it —
 * `aai dev` and the scaffold's `server.mjs`.
 *
 * @module
 */

import type { Db } from "@alexkroman1/aai/internal";
import type { Logger } from "./runtime-config.ts";

/**
 * One row per run.
 *
 * `aai_`-first for the reason `SESSION_STATE_TABLE` is: the studio counts every
 * base table in an app's schema and shows it as the AUTHOR's own usage, so a
 * table they did not create has to say whose it is.
 *
 * @internal
 */
export const WORKFLOW_RUN_TABLE = "aai_workflow_runs";

/** One row per settled step, plus the attempt counter and the two wait kinds. */
export const WORKFLOW_STEP_TABLE = "aai_workflow_steps";
export const WORKFLOW_ATTEMPT_TABLE = "aai_workflow_attempts";
export const WORKFLOW_SLEEP_TABLE = "aai_workflow_sleeps";
export const WORKFLOW_HOOK_TABLE = "aai_workflow_hooks";

const CREATE_RUNS = (t: string) => `create table if not exists ${t} (
  run_id text primary key,
  workflow text not null,
  status text not null,
  created_at bigint not null,
  input jsonb not null,
  output jsonb,
  error text
)`;

/**
 * `(workflow, created_at desc)` because `listRuns` is the only query that scans,
 * and it always filters by the declared key and orders newest first.
 */
const CREATE_RUNS_INDEX = (t: string) =>
  `create index if not exists ${WORKFLOW_RUN_TABLE}_recent on ${t} (workflow, created_at desc)`;

const CREATE_STEPS = (t: string) => `create table if not exists ${t} (
  run_id text not null,
  key text not null,
  name text not null,
  status text not null,
  output jsonb,
  error text,
  attempts integer not null,
  finished_at bigint not null,
  primary key (run_id, key)
)`;

const CREATE_ATTEMPTS = (t: string) => `create table if not exists ${t} (
  run_id text not null,
  key text not null,
  n integer not null,
  primary key (run_id, key)
)`;

const CREATE_SLEEPS = (t: string) => `create table if not exists ${t} (
  run_id text not null,
  key text not null,
  wake_at bigint not null,
  woken boolean not null default false,
  correlation_id text,
  kind text not null,
  primary key (run_id, key)
)`;

/**
 * `token` is UNIQUE across every run, not per run.
 *
 * A signaller knows the token and not the run, so the index has to be global —
 * and the uniqueness is what turns two waits sharing a token into a refusal
 * rather than a signal resolving whichever row the planner reached first.
 */
const CREATE_HOOKS = (t: string) => `create table if not exists ${t} (
  run_id text not null,
  key text not null,
  token text not null unique,
  delivered boolean not null default false,
  payload jsonb,
  closed boolean not null default false,
  primary key (run_id, key)
)`;

/**
 * The five tables, for whoever owns the database.
 *
 * @internal
 */
export function workflowJournalDdl(schema?: string): string[] {
  const q = (table: string) => (schema ? `"${schema}".${table}` : table);
  return [
    CREATE_RUNS(q(WORKFLOW_RUN_TABLE)),
    CREATE_RUNS_INDEX(q(WORKFLOW_RUN_TABLE)),
    CREATE_STEPS(q(WORKFLOW_STEP_TABLE)),
    CREATE_ATTEMPTS(q(WORKFLOW_ATTEMPT_TABLE)),
    CREATE_SLEEPS(q(WORKFLOW_SLEEP_TABLE)),
    CREATE_HOOKS(q(WORKFLOW_HOOK_TABLE)),
  ];
}

/**
 * Apply the DDL to a database this process OWNS, at boot, best-effort.
 *
 * Never fatal, for the reason `applySessionStateDdl` gives in full: a
 * self-hosted role that may not CREATE — because a real migration already made
 * these tables — must keep booting, and if they genuinely are absent the
 * backend's own error says exactly that, which is the better diagnostic.
 *
 * @internal
 */
export async function applyWorkflowJournalDdl(opts: { db: Db; logger: Logger }): Promise<boolean> {
  try {
    for (const statement of workflowJournalDdl()) await opts.db.query(statement);
    return true;
  } catch (err: unknown) {
    opts.logger.warn?.("Workflow journal schema not applied", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
