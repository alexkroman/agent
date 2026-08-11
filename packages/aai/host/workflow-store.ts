// Copyright 2026 the AAI authors. MIT license.
/**
 * The workflow journal — durable state for {@link WorkflowRunStatus} runs.
 *
 * Two tables in the app's own schema, reached through the same one-method
 * {@link Db} that tool code sees as `ctx.db`: `aai_workflow_runs` (one row
 * per run) and `aai_workflow_steps` (one row per COMPLETED step). Failed
 * attempts are deliberately not rows — a step retries in process and only its
 * success is a fact worth replaying (see `host/workflow-engine.ts`).
 *
 * {@link WorkflowStore} is a seam, not an abstraction for its own sake: the
 * engine's semantics (replay, lease recovery, suspension) are what the tests
 * need to exercise, and they are the half that has nothing to do with SQL.
 * `createPostgresWorkflowStore` is the only implementation that ships.
 *
 * Time crosses this boundary as epoch milliseconds. Inside the SQL it is
 * `timestamptz` so `wake_at <= now()` is a plain comparison evaluated by the
 * database clock (the one clock every sandbox agrees on); the reads cast back
 * through `float8` because `extract(epoch …)` is `numeric`, which the driver
 * hands over as a STRING.
 */

import type { Db } from "../sdk/db.ts";
import type { WorkflowRunSnapshot, WorkflowRunStatus } from "../sdk/workflow.ts";

/** A claimed run, as the engine needs it to start executing. */
export type ClaimedRun = {
  runId: string;
  /** Key the workflow was declared under in `agent({ workflows })`. */
  workflow: string;
  /** The validated input `start()` was called with, round-tripped through jsonb. */
  input: unknown;
};

/**
 * Durable storage for workflow runs.
 *
 * @internal
 */
export type WorkflowStore = {
  /** Create the tables if they are absent. Idempotent; called once per engine. */
  init(): Promise<void>;
  /** Insert a `pending` run. */
  create(runId: string, workflow: string, input: unknown): Promise<void>;
  /**
   * Take ownership of a run for `leaseMs`, returning it only if the claim
   * succeeded — the one guard against two sandboxes replaying one run.
   *
   * Claimable means: `pending`, or `sleeping` and due, or `running` with an
   * EXPIRED lease (the previous executor died). Terminal runs never are.
   */
  claim(runId: string, leaseMs: number): Promise<ClaimedRun | undefined>;
  /** Ids of runs ready to execute now — due sleepers, unclaimed and abandoned runs. */
  due(limit: number): Promise<string[]>;
  /** Journaled step outputs for a run, keyed by step id, in journal order. */
  completedSteps(runId: string): Promise<Map<string, unknown>>;
  /** Record one step's success. Resolves with the run's new step count. */
  recordStep(runId: string, stepId: string, output: unknown): Promise<number>;
  /** Release a run until `wakeAt` (epoch ms). */
  suspend(runId: string, wakeAt: number): Promise<void>;
  /** Mark a run `completed` with its return value. */
  complete(runId: string, output: unknown): Promise<void>;
  /** Mark a run `failed` with a message. */
  fail(runId: string, error: string): Promise<void>;
  /** Read a run's observable state. */
  get(runId: string): Promise<WorkflowRunSnapshot | undefined>;
  /**
   * Store bytes a caller uploaded, OUTSIDE the journal, and resolve their id.
   *
   * This exists because of what the journal is: replay reads every step row
   * back through {@link Db}, so audio or a document in a step output (or in a
   * run's input) is re-read on every resume and counts against
   * `MAX_DB_RESULT_ROWS`. A browser cannot reach `ctx.db` itself, so bytes it
   * wants a run to work on have to land somewhere first, and that somewhere
   * must not be the journal. The run then names the blob and reads it with
   * ordinary SQL — it is the app's own schema.
   *
   * Base64 rather than `bytea` so the value survives the same JSON round trip
   * every other column here does.
   */
  putBlob(blobId: string, contentType: string, base64: string): Promise<void>;
  /** Read a blob back. Resolves undefined when no such id exists (or it was swept). */
  getBlob(blobId: string): Promise<{ contentType: string; base64: string } | undefined>;
  /** Delete one blob. Resolves whether a row was removed. */
  deleteBlob(blobId: string): Promise<boolean>;
  /**
   * Delete blobs older than `maxAgeMs`. An upload whose run was never started
   * — a closed tab, a failed start — is referenced by nothing, so nothing else
   * would ever remove it.
   */
  pruneBlobs(maxAgeMs: number): Promise<number>;
};

/** Statuses a claim may take over, as a SQL list. */
const CLAIMABLE = "('pending', 'sleeping', 'running')";

const CREATE_RUNS = `create table if not exists aai_workflow_runs (
  run_id text primary key,
  workflow text not null,
  input jsonb,
  status text not null default 'pending',
  output jsonb,
  error text,
  wake_at timestamptz,
  lease_until timestamptz,
  steps_completed int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)`;

const CREATE_STEPS = `create table if not exists aai_workflow_steps (
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
const CREATE_BLOBS = `create table if not exists aai_workflow_blobs (
  blob_id text primary key,
  content_type text not null,
  data text not null,
  bytes int not null,
  created_at timestamptz not null default now()
)`;

/** For the age sweep — without it pruning scans every blob ever uploaded. */
const CREATE_BLOBS_INDEX = `create index if not exists aai_workflow_blobs_created
  on aai_workflow_blobs (created_at)`;

/**
 * Partial index over exactly the rows {@link WorkflowStore.due} scans. Without
 * it that query is a full scan of every run the app has ever made, run on a
 * timer — and completed runs are kept (they are the run history a UI reads),
 * so the table only grows.
 */
const CREATE_DUE_INDEX = `create index if not exists aai_workflow_runs_due
  on aai_workflow_runs (wake_at, lease_until)
  where status in ('pending', 'sleeping', 'running')`;

/**
 * Every jsonb parameter is bound `::text::jsonb`, and the `::text` is
 * LOAD-BEARING — it reads like a no-op and is the difference between a journal
 * that works and one that silently double-encodes everything in it.
 *
 * `postgres` (the driver behind {@link Db}) decides a parameter's encoding from
 * the type Postgres infers for it. Bound straight to `$3::jsonb`, the JS string
 * this code passes is JSON-ENCODED BY THE DRIVER, so a `{"a":1}` arrives as the
 * jsonb *string* `"{\"a\":1}"` — our `JSON.stringify` and the driver's are two
 * encodings of one value. Measured against a real Postgres 16, every type is
 * affected: an object input comes back as a string (so a run whose `run` body
 * iterates it dies on "not iterable"), a step returning `"text"` replays as
 * `"\"text\""`, and a completed run's `output` reaches `GET /workflows/runs/:id`
 * as a string. Interposing `::text` makes Postgres infer `text` for the
 * parameter, so the driver sends the bytes as-is and the cast parses them once.
 *
 * Passing the raw value instead (letting the driver do the only encoding) is the
 * obvious alternative and is WRONG here: `Db` is one `query(sql, params)` with no
 * per-parameter type channel, so a step returning a bare `true` fails with
 * "cannot cast type boolean to jsonb", and a step returning a plain string would
 * have its text parsed as JSON. `stringify` + `::text::jsonb` is the only
 * spelling of the four that round-trips object, string, number, boolean, array,
 * null AND undefined.
 *
 * None of this is reachable by the engine's own suite, which runs on the
 * in-memory store (`_workflow-test-utils.ts`) and holds JS values directly — so
 * the statements are asserted as TEXT in `workflow-store.test.ts`. A fake that
 * stores what it is handed cannot see an encoding bug in the driver beneath it.
 *
 * Journal backed by the app's Postgres schema.
 *
 * @internal
 */
export function createPostgresWorkflowStore(db: Db): WorkflowStore {
  return {
    async init(): Promise<void> {
      // Sequential rather than concurrent: the steps table's foreign key
      // requires the runs table to exist first, and the index requires both.
      await db.query(CREATE_RUNS);
      await db.query(CREATE_STEPS);
      await db.query(CREATE_DUE_INDEX);
      await db.query(CREATE_BLOBS);
      await db.query(CREATE_BLOBS_INDEX);
    },

    async create(runId: string, workflow: string, input: unknown): Promise<void> {
      await db.query(
        "insert into aai_workflow_runs (run_id, workflow, input) values ($1, $2, $3::text::jsonb)",
        [runId, workflow, JSON.stringify(input ?? null)],
      );
    },

    async claim(runId: string, leaseMs: number): Promise<ClaimedRun | undefined> {
      const rows = await db.query<{ workflow: string; input: unknown }>(
        `update aai_workflow_runs
            set status = 'running',
                lease_until = now() + make_interval(secs => $2::float8),
                updated_at = now()
          where run_id = $1
            and status in ${CLAIMABLE}
            and (wake_at is null or wake_at <= now())
            and (status <> 'running' or lease_until is null or lease_until < now())
          returning workflow, input`,
        [runId, leaseMs / 1000],
      );
      const row = rows[0];
      return row ? { runId, workflow: row.workflow, input: row.input } : undefined;
    },

    async due(limit: number): Promise<string[]> {
      const rows = await db.query<{ run_id: string }>(
        `select run_id from aai_workflow_runs
          where (status in ('pending', 'sleeping') and (wake_at is null or wake_at <= now()))
             or (status = 'running' and lease_until is not null and lease_until < now())
          order by created_at
          limit $1`,
        [limit],
      );
      return rows.map((r) => r.run_id);
    },

    async completedSteps(runId: string): Promise<Map<string, unknown>> {
      // Ordered by the insertion sequence so the map's iteration order is the
      // order the run journaled them — what makes a step-count read meaningful.
      const rows = await db.query<{ step_id: string; output: unknown }>(
        "select step_id, output from aai_workflow_steps where run_id = $1 order by seq",
        [runId],
      );
      return new Map(rows.map((r) => [r.step_id, r.output]));
    },

    async recordStep(runId: string, stepId: string, output: unknown): Promise<number> {
      await db.query(
        `insert into aai_workflow_steps (run_id, step_id, output) values ($1, $2, $3::text::jsonb)
           on conflict (run_id, step_id) do update set output = excluded.output`,
        [runId, stepId, JSON.stringify(output ?? null)],
      );
      const rows = await db.query<{ steps_completed: number }>(
        `update aai_workflow_runs
            set steps_completed = (select count(*)::int from aai_workflow_steps where run_id = $1),
                updated_at = now()
          where run_id = $1
          returning steps_completed`,
        [runId],
      );
      return rows[0]?.steps_completed ?? 0;
    },

    async suspend(runId: string, wakeAt: number): Promise<void> {
      await db.query(
        `update aai_workflow_runs
            set status = 'sleeping',
                wake_at = to_timestamp($2::float8 / 1000.0),
                lease_until = null,
                updated_at = now()
          where run_id = $1`,
        [runId, wakeAt],
      );
    },

    async complete(runId: string, output: unknown): Promise<void> {
      await db.query(
        `update aai_workflow_runs
            set status = 'completed', output = $2::text::jsonb, lease_until = null,
                wake_at = null, updated_at = now()
          where run_id = $1`,
        [runId, JSON.stringify(output ?? null)],
      );
    },

    async fail(runId: string, error: string): Promise<void> {
      await db.query(
        `update aai_workflow_runs
            set status = 'failed', error = $2, lease_until = null,
                wake_at = null, updated_at = now()
          where run_id = $1`,
        [runId, error],
      );
    },

    async get(runId: string): Promise<WorkflowRunSnapshot | undefined> {
      const rows = await db.query<{
        workflow: string;
        status: WorkflowRunStatus;
        output: unknown;
        error: string | null;
        wake_at_ms: number | null;
        steps_completed: number;
      }>(
        `select workflow, status, output, error, steps_completed,
                (extract(epoch from wake_at) * 1000)::float8 as wake_at_ms
           from aai_workflow_runs where run_id = $1`,
        [runId],
      );
      const row = rows[0];
      if (!row) return;
      // `output` and `error` are reported only in the state that defines them:
      // a failed run's stale `output` column (from a prior completed attempt
      // of the same id) would otherwise read as a result.
      return {
        runId,
        workflow: row.workflow,
        status: row.status,
        stepsCompleted: row.steps_completed,
        ...(row.status === "completed" ? { output: row.output } : {}),
        ...(row.status === "failed" && row.error !== null ? { error: row.error } : {}),
        ...(row.status === "sleeping" && row.wake_at_ms !== null ? { wakeAt: row.wake_at_ms } : {}),
      };
    },

    async putBlob(blobId: string, contentType: string, base64: string): Promise<void> {
      await db.query(
        `insert into aai_workflow_blobs (blob_id, content_type, data, bytes)
         values ($1, $2, $3, $4)`,
        // The byte count is stored rather than derived on read: every consumer
        // wants it (a page reporting progress, a step sizing a request) and
        // recovering it from base64 means decoding the whole payload.
        [blobId, contentType, base64, Math.floor((base64.length * 3) / 4)],
      );
    },

    async getBlob(blobId: string): Promise<{ contentType: string; base64: string } | undefined> {
      const rows = await db.query<{ content_type: string; data: string }>(
        "select content_type, data from aai_workflow_blobs where blob_id = $1",
        [blobId],
      );
      const row = rows[0];
      return row ? { contentType: row.content_type, base64: row.data } : undefined;
    },

    async deleteBlob(blobId: string): Promise<boolean> {
      const rows = await db.query<{ blob_id: string }>(
        "delete from aai_workflow_blobs where blob_id = $1 returning blob_id",
        [blobId],
      );
      return rows.length > 0;
    },

    async pruneBlobs(maxAgeMs: number): Promise<number> {
      const rows = await db.query<{ blob_id: string }>(
        `delete from aai_workflow_blobs
          where created_at < now() - make_interval(secs => $1::float8)
          returning blob_id`,
        [maxAgeMs / 1000],
      );
      return rows.length;
    },
  };
}
