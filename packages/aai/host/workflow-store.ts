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
import type { WorkflowRunSnapshot } from "../sdk/workflow.ts";
import { createBlobMethods } from "./workflow-blob-store.ts";
import { createReadMethods } from "./workflow-read-store.ts";
import {
  CREATE_MIGRATIONS,
  LIVE,
  MIGRATIONS,
  RECORD_MIGRATION,
  SELECT_MIGRATIONS,
} from "./workflow-schema.ts";
import { scopeClause } from "./workflow-scope.ts";
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
  /**
   * Insert a `pending` run.
   *
   * `key` is the caller's own correlation handle (see `StartOptions.key`) and is
   * deliberately NOT unique: two runs may share one, and `findByKey` orders them
   * newest first.
   */
  create(
    runId: string,
    workflow: string,
    input: unknown,
    key?: string | undefined,
    /** Continuations deep — see `ADD_CONTINUATION_DEPTH`. Defaults to 0. */
    continuationDepth?: number,
    /**
     * Who the run belongs to — see `ADD_OWNER_SCOPE`. Undefined for an app that
     * declares no identity, which is every app until one adds `identify`.
     */
    ownerScope?: string | undefined,
  ): Promise<void>;
  /** How many continuations deep `runId` is, or 0 when it does not exist. */
  continuationDepth(runId: string): Promise<number>;
  /**
   * Who owns `runId`, or undefined for an unscoped run (and for one that does not
   * exist).
   *
   * Read by `createContinuation` so a successor INHERITS its predecessor's owner.
   * Without it continue-as-new launders a run out of its owner's view mid-chain:
   * the successor would belong to nobody, becoming invisible to the user who
   * started the work and visible to an unscoped caller — a silent ownership
   * change, which is worse than a refusal.
   */
  ownerScope(runId: string): Promise<string | undefined>;
  /**
   * Take ownership of a run for `leaseMs`, returning it only if the claim
   * succeeded — the one guard against two sandboxes replaying one run.
   *
   * Claimable means: `pending`, or `sleeping` and due, or `running` with an
   * EXPIRED lease (the previous executor died). Terminal runs never are, which
   * is what makes `cancel` stick.
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
  /**
   * Park a run on a WAITPOINT: released like a sleep, but woken by
   * {@link signal} rather than by a clock.
   *
   * `timeoutAt` is optional and is an ordinary wake time, so a parked run with
   * one is due at that instant exactly like a sleeper — which is what lets a
   * timeout need no second mechanism. Without one the run waits indefinitely and
   * costs a row.
   */
  park(runId: string, token: string, stepId: string, timeoutAt?: number): Promise<void>;
  /**
   * Resolve a waitpoint by its token, journaling `payload` as the step's output
   * and returning the run to `pending`.
   *
   * Resolves the run id, or `undefined` when no run is parked on that token —
   * which covers an unknown token, a run already resumed (the token is cleared,
   * so it is single-use), and a run that timed out and moved on. All three are
   * the same answer to the caller and none of them is an error: a webhook that
   * retries is ordinary.
   *
   * The step id it journals under comes from the row (`wait_step`, written by
   * {@link park}), not from the caller: the entry has to be the one the replay's
   * `ctx.waitFor` will look for, and only the execution that parked knows its
   * ordinal.
   */
  signal(token: string, payload: unknown): Promise<string | undefined>;
  /** Mark a run `completed` with its return value. */
  complete(runId: string, output: unknown): Promise<void>;
  /** Mark a run `failed` with a message. */
  fail(runId: string, error: string): Promise<void>;
  /**
   * Return a TERMINAL run to `pending` so an executor picks it up again,
   * resolving whether this call is what revived it.
   *
   * The journal is KEPT, which is what makes this a resume rather than a restart:
   * replay short-circuits every step that already succeeded, so a run that failed
   * on step 27 re-runs step 27 and nothing before it. Re-running the completed
   * work would be both wasteful and, for a step with an external side effect,
   * wrong — the at-least-once contract is per step, not per operator click.
   *
   * Only `failed` and `cancelled` are revivable. A LIVE run must not be reset:
   * one already executing would then have two claimants, which is the single thing
   * the lease exists to prevent.
   */
  retry(runId: string, scope?: string | undefined): Promise<boolean>;
  /**
   * Mark a live run `cancelled`. Resolves whether this call is what ended it —
   * false for a run that was already terminal, or absent.
   *
   * The journal is kept: what the run did before it was stopped stays readable,
   * and a cancelled run is never claimed again so nothing will add to it.
   */
  cancel(runId: string, scope?: string | undefined): Promise<boolean>;
  /** Read a run's observable state. */
  get(runId: string, scope?: string | undefined): Promise<WorkflowRunSnapshot | undefined>;
  /** Runs of one workflow carrying `key`, newest first. */
  findByKey(
    workflow: string,
    key: string,
    limit: number,
    scope?: string | undefined,
  ): Promise<WorkflowRunSnapshot[]>;
  /**
   * Runs of one workflow, newest first, whatever key they carry.
   *
   * The OPERATOR's read, where {@link findByKey} is the agent's: a console asking
   * "what has this workflow been doing" has no key to ask about, and most runs
   * carry none at all (a page holds its own `runId`). Deliberately a separate
   * method rather than `findByKey` with a nullable key — a keyless lookup is not a
   * lookup that matched every key, and conflating them is how a caller meaning
   * "this session's runs" silently reads every tenant session's instead.
   */
  recent(
    workflow: string,
    limit: number,
    scope?: string | undefined,
  ): Promise<WorkflowRunSnapshot[]>;
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
  /**
   * Record one step's success. A local function rather than only a method, so
   * `signal` below can journal a waitpoint's payload without reaching through
   * `this` — the store is a returned object literal, where `this` is untyped
   * under `noImplicitThis` and breaks the moment a caller destructures it.
   */
  async function recordStep(runId: string, stepId: string, output: unknown): Promise<number> {
    // Deliberately NOT gated on the run being live: the step already ran, and a
    // journal that records what happened stays truthful even for a run that was
    // cancelled underneath it. Nothing will claim it again, so nothing will read
    // the extra row.

    // Deliberately NOT gated on the run being live: the step already ran, and
    // a journal that records what happened stays truthful even for a run that
    // was cancelled underneath it. Nothing will claim it again, so nothing
    // will read the extra row.
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
  }

  return {
    async init(): Promise<void> {
      // The ledger first, then only what it does not already record. See
      // `MIGRATIONS` for why each statement is still individually idempotent, and
      // why re-running them all on every boot was not free.
      await db.query(CREATE_MIGRATIONS);
      const applied = new Set(
        (await db.query<{ id: string }>(SELECT_MIGRATIONS)).map((row) => row.id),
      );
      for (const migration of MIGRATIONS) {
        if (applied.has(migration.id)) continue;
        // Sequential, and recorded immediately after its own statement: a crash
        // between two migrations must leave the earlier one recorded, or the next
        // boot re-runs it — harmless here (they are idempotent) and not a property
        // to lean on.
        await db.query(migration.sql);
        await db.query(RECORD_MIGRATION, [migration.id]);
      }
    },

    async create(
      runId: string,
      workflow: string,
      input: unknown,
      key?: string | undefined,
      continuationDepth = 0,
      ownerScope?: string | undefined,
    ): Promise<void> {
      await db.query(
        `insert into aai_workflow_runs
           (run_id, workflow, input, correlation_key, continuation_depth, owner_scope)
         values ($1, $2, $3::text::jsonb, $4, $5, $6)`,
        [
          runId,
          workflow,
          JSON.stringify(input ?? null),
          key ?? null,
          continuationDepth,
          ownerScope ?? null,
        ],
      );
    },

    async ownerScope(runId: string): Promise<string | undefined> {
      const rows = await db.query<{ owner_scope: string | null }>(
        "select owner_scope from aai_workflow_runs where run_id = $1",
        [runId],
      );
      return rows[0]?.owner_scope ?? undefined;
    },

    async continuationDepth(runId: string): Promise<number> {
      const rows = await db.query<{ continuation_depth: number }>(
        "select continuation_depth from aai_workflow_runs where run_id = $1",
        [runId],
      );
      return Number(rows[0]?.continuation_depth ?? 0);
    },

    async claim(runId: string, leaseMs: number): Promise<ClaimedRun | undefined> {
      const rows = await db.query<{ workflow: string; input: unknown }>(
        `update aai_workflow_runs
            set status = 'running',
                lease_until = now() + make_interval(secs => $2::float8),
                updated_at = now()
          where run_id = $1
            and status in ${LIVE}
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

    recordStep,

    async park(runId, token, stepId, timeoutAt): Promise<void> {
      await db.query(
        `update aai_workflow_runs
            set status = 'sleeping',
                wait_token = $2,
                wait_step = $3,
                wake_at = case when $4::float8 is null
                          then null else to_timestamp($4::float8 / 1000.0) end,
                lease_until = null,
                updated_at = now()
          where run_id = $1 and status in ${LIVE}`,
        [runId, token, stepId, timeoutAt ?? null],
      );
    },

    async signal(token: string, payload: unknown): Promise<string | undefined> {
      // One statement, so the claim of the token and the journal write cannot
      // interleave with a second caller presenting the same token: the update's
      // `wait_token = $1` predicate is what makes it single-use, and it is
      // evaluated once. Two concurrent webhook deliveries therefore produce one
      // resume and one `undefined`.
      const rows = await db.query<{ run_id: string; wait_step: string | null }>(
        `update aai_workflow_runs
            set status = 'pending',
                wait_token = null,
                wait_step = null,
                wake_at = null,
                lease_until = null,
                updated_at = now()
          where wait_token = $1 and status = 'sleeping'
      returning run_id, wait_step`,
        [token],
      );
      const row = rows[0];
      const runId = row?.run_id;
      const stepId = row?.wait_step;
      // `wait_step` is written by `park` in the same statement as the token, so a
      // row carrying one and not the other cannot be produced by this code.
      // Answered as "no such waitpoint" rather than asserted, because the
      // alternative is throwing at a webhook that will simply retry.
      if (runId === undefined || !stepId) return;
      // Journaled AFTER the status flip, deliberately. The other order leaves a
      // window where the payload is recorded against a run nobody has released,
      // so a crash in between parks it forever holding an answer it will never
      // read. This order's crash window instead leaves a `pending` run whose
      // replay reaches `waitFor`, finds no entry, and parks again on a FRESH
      // token — a lost signal, which the caller can retry, rather than a run
      // that can never finish.
      await recordStep(runId, stepId, payload);
      return runId;
    },

    async suspend(runId: string, wakeAt: number): Promise<void> {
      await db.query(
        `update aai_workflow_runs
            set status = 'sleeping',
                wake_at = to_timestamp($2::float8 / 1000.0),
                lease_until = null,
                updated_at = now()
          where run_id = $1 and status in ${LIVE}`,
        [runId, wakeAt],
      );
    },

    async complete(runId: string, output: unknown): Promise<void> {
      await db.query(
        `update aai_workflow_runs
            set status = 'completed', output = $2::text::jsonb, lease_until = null,
                wake_at = null, updated_at = now()
          where run_id = $1 and status in ${LIVE}`,
        [runId, JSON.stringify(output ?? null)],
      );
    },

    async fail(runId: string, error: string): Promise<void> {
      await db.query(
        `update aai_workflow_runs
            set status = 'failed', error = $2, lease_until = null,
                wake_at = null, updated_at = now()
          where run_id = $1 and status in ${LIVE}`,
        [runId, error],
      );
    },

    async cancel(runId: string, scope?: string | undefined): Promise<boolean> {
      const rows = await db.query<{ run_id: string }>(
        `update aai_workflow_runs
            set status = 'cancelled', lease_until = null, wake_at = null, updated_at = now()
          where run_id = $1 and status in ${LIVE}${scopeClause(scope, 2)}
          returning run_id`,
        scope === undefined ? [runId] : [runId, scope],
      );
      return rows.length > 0;
    },

    async retry(runId: string, scope?: string | undefined): Promise<boolean> {
      const rows = await db.query<{ run_id: string }>(
        `update aai_workflow_runs
            set status = 'pending', error = null, wake_at = null, lease_until = null,
                updated_at = now()
          where run_id = $1 and status in ('failed', 'cancelled')${scopeClause(scope, 2)}
          returning run_id`,
        scope === undefined ? [runId] : [runId, scope],
      );
      return rows.length > 0;
    },

    ...createReadMethods(db),

    ...createBlobMethods(db),
  };
}
