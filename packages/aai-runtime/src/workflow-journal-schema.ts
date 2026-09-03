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
import { errorMessage } from "@alexkroman1/aai/utils";
import { createPostgresDb } from "./postgres-db.ts";
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
/**
 * One row per OUTSTANDING attempt, and a new table rather than a changed one.
 *
 * `aai_workflow_attempts` held a scalar `n` keyed `(run_id, key)`, and a scalar
 * cannot expire: the charge a dead walk left was indistinguishable from a live
 * one and stood forever, so `maxAttempts` deaths on one step key refused it
 * permanently. Expiring individual charges needs a timestamp PER charge, which
 * needs a row per charge, which needs the holder in the primary key — so the key
 * changes, and `create table if not exists` cannot change a key.
 *
 * The old table is left in place rather than dropped here. A shipped DDL
 * applier runs on operator databases, and `drop table` is not a thing a library
 * should do to one on its own initiative; the platform's own migration retires
 * its copy, and a self-hoster's is an empty table nothing reads. Outstanding
 * charges are lost at the changeover, which is the safe direction — see
 * `JournalStore.releaseAttempt` on why under-charging is recoverable and
 * over-charging is not.
 */
export const WORKFLOW_ATTEMPT_TABLE = "aai_workflow_attempt_leases";
export const WORKFLOW_SLEEP_TABLE = "aai_workflow_sleeps";
export const WORKFLOW_HOOK_TABLE = "aai_workflow_hooks";

/**
 * `input` is NULLABLE, matching `aai_platform.workflow_runs`.
 *
 * A run's input is whatever the caller passed and a workflow declaring no schema
 * is handed it untouched, so `undefined` is representable — and the engine's own
 * refusal of a non-record input is what turns that into a legible abandoned run.
 * `not null` here made the same start fail inside the DRIVER instead, on the
 * only one of the three backends that had the constraint, so the three stopped
 * being one contract at exactly the boundary the platform migration's comment
 * claims differs by tenancy alone.
 */
const CREATE_RUNS = (t: string) => `create table if not exists ${t} (
  run_id text primary key,
  workflow text not null,
  status text not null,
  created_at bigint not null,
  input jsonb,
  output jsonb,
  error text,
  code_version text
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
  started_at bigint,
  finished_at bigint not null,
  primary key (run_id, key)
)`;

/**
 * `started_at` on a table that already exists.
 *
 * The FIRST of these, so it carries the argument both share; see
 * {@link ALTER_RUNS_CODE_VERSION} for the second.
 *
 * `create table if not exists` is a NO-OP once the table is there, so a column
 * added to {@link CREATE_STEPS} reaches a fresh deployment and no existing one —
 * which for a self-hoster is the deployment that matters. `add column if not
 * exists` is idempotent, so it runs at every boot for the price of one
 * catalogue lookup.
 *
 * Nullable, and it has to be: the rows already there have no start, and a
 * default would invent one. `StepEntry.startedAt` is optional for the same
 * reason and says what a reader owes an absent value.
 *
 * The residual is the one this module's applier already lives with — a role that
 * may not ALTER gets a warned, swallowed failure and then a `42703` from the
 * store's own insert. That is the operator's migration to run, which is what
 * `ensureWorkflowJournalSchema` being PUBLIC is for.
 */
const ALTER_STEPS_STARTED_AT = (t: string) =>
  `alter table ${t} add column if not exists started_at bigint`;

/**
 * `code_version` on a runs table that already exists.
 *
 * Same mechanism, same nullability and the same residual as
 * {@link ALTER_STEPS_STARTED_AT} — read that one. Nullable here is not merely a
 * migration concession: only a deployed guest has a bundle hash at all, so a
 * self-hosted run legitimately has none for the life of the column, and
 * `RunRecord.codeVersion` says what a reader owes an absent value.
 */
const ALTER_RUNS_CODE_VERSION = (t: string) =>
  `alter table ${t} add column if not exists code_version text`;

/**
 * Every outstanding attempt for one step key: WHO holds a charge, and since when.
 *
 * `holders` is a map of holder to the instant it claimed, and the primary key
 * stays `(run_id, key)` — ONE row per key, not one per holder. That is the
 * atomicity: two concurrent claims collide on this row, so the second blocks and
 * re-evaluates against the first's committed value. A row per holder conflicts
 * on nothing and both claims answer `1`, which is a step's ceiling bounding
 * nothing; `_workflow-journal-attempts.ts` carries the measurement.
 *
 * Instants are milliseconds since the epoch, as TEXT inside the map, like every
 * other instant in this schema (`finished_at`, `wake_at`) and deliberately not a
 * `timestamptz`: the engine compares them against its OWN clock, so a type that
 * made the database the clock would put the two on different ones. A charge's
 * instant is set by the CLAIM and never refreshed by a live holder — see
 * `ATTEMPT_LEASE_MS`, which argues the window and what a heartbeat would buy.
 */
const CREATE_ATTEMPTS = (t: string) => `create table if not exists ${t} (
  run_id text not null,
  key text not null,
  holders jsonb not null default '{}'::jsonb,
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
 * Not purely `create table` statements any more: two `alter table … add column
 * if not exists` follow their tables, because a column added to a `create
 * … if not exists` reaches only a database that does not exist yet. See
 * {@link ALTER_STEPS_STARTED_AT}, which carries the argument.
 *
 * @internal
 */
export function workflowJournalDdl(schema?: string): string[] {
  const q = (table: string) => (schema ? `"${schema}".${table}` : table);
  return [
    CREATE_RUNS(q(WORKFLOW_RUN_TABLE)),
    ALTER_RUNS_CODE_VERSION(q(WORKFLOW_RUN_TABLE)),
    CREATE_RUNS_INDEX(q(WORKFLOW_RUN_TABLE)),
    CREATE_STEPS(q(WORKFLOW_STEP_TABLE)),
    ALTER_STEPS_STARTED_AT(q(WORKFLOW_STEP_TABLE)),
    CREATE_ATTEMPTS(q(WORKFLOW_ATTEMPT_TABLE)),
    CREATE_SLEEPS(q(WORKFLOW_SLEEP_TABLE)),
    CREATE_HOOKS(q(WORKFLOW_HOOK_TABLE)),
  ];
}

/**
 * Create the journal's tables on a database this deployment owns.
 *
 * **The half that was missing, and its absence broke every self-hosted durable
 * workflow.** `applyWorkflowJournalDdl` below existed from the start and had NO
 * production caller — so `aai dev` or a scaffolded `server.mjs` with a
 * `DATABASE_URL` printed `runStore: "postgres"` at boot and then died on the
 * first run with `42P01 relation "aai_workflow_runs" does not exist`. The boot
 * line said durable and nothing was.
 *
 * **PUBLIC, for the reason `ensureSessionStateSchema` is** — the operator who
 * needs it is not ours. `aai dev` could reach the applier through
 * `@alexkroman1/aai-runtime/internal`; `server.mjs` is a file that SHIPS to a
 * user and may import only the published surface, so a self-hosted deployment
 * could not apply the DDL it is contractually responsible for. That module
 * records the same rule one table over, and this is the second time it has been
 * the missing half rather than a convenience.
 *
 * It opens its OWN single-connection pool and closes it, again mirroring that
 * function: the caller has no `Db` yet, the runtime builds one from the same URL
 * afterwards, and a pool held open for six statements would sit against the
 * connection budget for the life of the process.
 *
 * @public
 */
export async function ensureWorkflowJournalSchema(opts: {
  url: string;
  logger: Logger;
}): Promise<boolean> {
  const db = createPostgresDb({ url: opts.url, max: 1 });
  try {
    return await applyWorkflowJournalDdl({ db, logger: opts.logger });
  } finally {
    await db.close().catch(() => undefined);
  }
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
    opts.logger.warn?.("Workflow journal schema not applied", { error: errorMessage(err) });
    return false;
  }
}
