// Copyright 2026 the AAI authors. MIT license.
/**
 * `ctx.workflows` — the {@link WorkflowClient} implementation, over the Workflow
 * Development Kit.
 *
 * There is no engine in this file and there is not meant to be one. Every method
 * is a translation between two vocabularies:
 *
 * | ours | WDK |
 * | --- | --- |
 * | `start(def, input, { key })` | `start({ workflowId }, [input])` + our key index |
 * | `get(runId)` | `world.runs.get(runId)` |
 * | `find(def, key)` | key index → `world.runs.get` per id |
 * | `recent(def)` | `world.runs.list({ workflowName })` |
 * | `cancel(runId)` | `getRun(runId).cancel()` |
 * | `wakeUp(runId)` | `getRun(runId).wakeUp()` |
 * | `stream(runId)` | `getRun(runId).getReadable()` |
 * | `listing()` | the declared `workflows` record |
 *
 * Two translations are worth reading before changing them: the name mapping,
 * which is what makes a rename a one-place change, and the snapshot mapping,
 * which is where WDK's run record becomes a discriminated union.
 */

import type { Db } from "../sdk/db.ts";
import { mapInBatches } from "../sdk/map-in-batches.ts";
import { formatSchemaIssues, toToolJsonSchema } from "../sdk/schema.ts";
import { errorMessage } from "../sdk/utils.ts";
import type {
  AnyWorkflowDef,
  FindOptions,
  StartOptions,
  StreamOptions,
  WakeUpOptions,
  WorkflowClient,
  WorkflowDef,
  WorkflowSummary,
} from "../sdk/workflow.ts";
import type { WorkflowRunSnapshot } from "../sdk/workflow-run.ts";
import { MISSING_WORKFLOW_ID_MESSAGE } from "../sdk/workflow-unavailable.ts";
import type { Logger } from "./runtime-config.ts";
import {
  createMemoryKeyStore,
  createPostgresKeyStore,
  resolveFindLimit,
  type WorkflowKeyStore,
} from "./workflow-keys.ts";

/**
 * How many runs a listing reads at once.
 *
 * `find` and `recent` are bounded by `resolveFindLimit`, whose ceiling is
 * `MAX_WORKFLOW_FIND_LIMIT` (100) — so an unbounded `Promise.all` over the
 * result let ONE request put 100 concurrent reads on the app's Postgres, a pool
 * this shares with `ctx.db` and the world's own queue. The route is fail-open
 * unless the operator set `AAI_WORKFLOW_API_TOKEN`, so the caller does not have
 * to be trusted for that to matter.
 *
 * Eight rather than a tuned number: the reads are short and the point is a
 * CEILING, not a throughput target — the tail of a 100-run listing is dominated
 * by the slowest batch either way.
 */
const RUN_READ_CONCURRENCY = 8;

/** What a client needs to serve `ctx.workflows`. */
export type WorkflowClientOptions = {
  /** The agent's declared workflows, keyed by the name they are declared under. */
  workflows: Readonly<Record<string, WorkflowDef>>;
  /**
   * Where correlation keys are recorded. Pass a Postgres store in production and
   * a memory store under `aai dev` — see `workflow-keys.ts`.
   */
  keys: WorkflowKeyStore;
  /**
   * The WDK entry points, injected rather than imported so this module can be
   * specified without a world. Production passes `wdkAdapter` (`workflow-wdk.ts`).
   */
  wdk: WdkAdapter;
  logger: Logger;
};

/**
 * The slice of the Workflow DevKit this client touches.
 *
 * A seam rather than a direct import, and the reason is testability rather than
 * abstraction for its own sake: `workflow/api`'s `start` resolves a World from
 * the environment at call time, so a unit test of "does `start` validate its
 * input before creating a run" would otherwise need a real Postgres or a
 * `.workflow-data/` directory to answer.
 */
export type WdkAdapter = {
  /** `start({ workflowId }, [input])` — resolves the new run's id. */
  start(workflowId: string, args: unknown[]): Promise<string>;
  /** `world.runs.get(runId)` — the raw record, or undefined when there is none. */
  getRun(runId: string): Promise<WdkRunRecord | undefined>;
  /** `world.runs.list({ workflowName })` — newest first, at most `limit`. */
  listRuns(workflowName: string, limit: number): Promise<WdkRunRecord[]>;
  /** `getRun(runId).cancel()` — resolves false when the run was already terminal. */
  cancel(runId: string): Promise<boolean>;
  /**
   * `getRun(runId).wakeUp()` — resolves how many pending sleeps were
   * interrupted, and `0` for a run that is gone.
   */
  wakeUp(runId: string, correlationIds: string[] | undefined): Promise<number>;
  /**
   * `getRun(runId).getReadable(options)` — the run's own written stream.
   *
   * Synchronous in WDK and here, because the underlying read is LAZY: it defers
   * the run lookup and the encryption-key resolution until a chunk is actually
   * pulled, which is what keeps an unread stream from costing anything.
   */
  readStream(runId: string, options: WdkStreamOptions): ReadableStream<unknown>;
  /**
   * The completed run's return value, hydrated.
   *
   * Separate from `getRun` because reading it costs a deserialization (and,
   * with encryption on, a key resolution) that a `pending` run has no use for.
   */
  readOutput(runId: string): Promise<unknown>;
};

/** What {@link WdkAdapter.readStream} passes through to WDK. */
export type WdkStreamOptions = {
  namespace?: string | undefined;
  startIndex?: number | undefined;
};

/**
 * A WDK run record, narrowed to the fields a snapshot is built from.
 *
 * `status` is typed as the WDK union rather than ours even though the two are
 * pinned equal (`workflow-status-align.test.ts`), because this type describes
 * what WDK returns; the mapping to ours is `toSnapshot`'s job.
 */
export type WdkRunRecord = {
  runId: string;
  workflowName: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  createdAt: Date | number;
  error?: { message: string } | undefined;
};

/**
 * Create the client tool code sees as `ctx.workflows`.
 *
 * @internal
 */
export function createWorkflowClient(opts: WorkflowClientOptions): WorkflowClient {
  const { workflows, keys, wdk, logger } = opts;

  /**
   * The declared name of a workflow, by IDENTITY against `agent({ workflows })`.
   *
   * Identity rather than a `name` field on the def is what keeps that record the
   * single source of the name: a workflow declared twice under two keys is a
   * legitimate (if odd) thing to write, and the def cannot know which key a
   * caller meant. It also means a rename is one edit — the key — rather than two
   * that can disagree.
   *
   * The reverse direction, name → def, is a plain lookup; `resolve` accepts
   * either so every overloaded method can take `WorkflowDef | string` without
   * restating this.
   */
  function resolve(workflow: AnyWorkflowDef | string): { name: string; def: WorkflowDef } {
    if (typeof workflow === "string") {
      const def = workflows[workflow];
      if (!def) throw new Error(unknownWorkflowMessage(workflow, Object.keys(workflows)));
      return { name: workflow, def };
    }
    for (const [name, def] of Object.entries(workflows)) {
      if (def === workflow) return { name, def };
    }
    // A def that is not in the record cannot be started: nothing maps it to a
    // name, so a run of it could never be found again. The message names the
    // declared set because the usual cause is a workflow written and not wired
    // into `agent({ workflows })`.
    throw new Error(
      unknownWorkflowMessage(workflow.description ?? "(unnamed)", Object.keys(workflows)),
    );
  }

  /**
   * Validate `input` against the workflow's schema, resolving the parsed value.
   *
   * A workflow with no `input` schema accepts anything, matching `tool()`. The
   * validation is here rather than inside the body because the body runs on a
   * queue: a schema failure there is a FAILED RUN discovered later, where here it
   * is a rejected `start()` at the call site the model can be told about.
   */
  async function validate(name: string, def: WorkflowDef, input: unknown): Promise<unknown> {
    if (!def.input) return input;
    const result = await def.input["~standard"].validate(input);
    if (result.issues) {
      throw new Error(`Invalid input for workflow "${name}": ${formatSchemaIssues(result.issues)}`);
    }
    return result.value;
  }

  /** The `workflowId` the WDK compiler attached, or a message naming the build. */
  function workflowIdOf(def: WorkflowDef): string {
    const id = def.run.workflowId;
    if (!id) throw new Error(MISSING_WORKFLOW_ID_MESSAGE);
    return id;
  }

  /**
   * WDK's run record as our discriminated snapshot.
   *
   * The `output` read is deliberately conditional on `status === "completed"`,
   * which is also what makes it cheap: `readOutput` polls until the run settles,
   * so calling it on a `running` run would block a snapshot read for the length
   * of the run. Having already observed a terminal status, the poll's first
   * iteration returns.
   */
  async function toSnapshot(
    record: WdkRunRecord,
    key: string | undefined,
  ): Promise<WorkflowRunSnapshot> {
    const base = {
      runId: record.runId,
      workflow: record.workflowName,
      createdAt: new Date(record.createdAt).getTime(),
      ...(key !== undefined && { key }),
    };
    switch (record.status) {
      case "completed":
        return { ...base, status: "completed", output: await wdk.readOutput(record.runId) };
      case "failed":
        // WDK records a failure with no message when the run died without one
        // (a killed container, a max-deliveries stop). An empty `error` on a
        // `failed` snapshot would read as "no error", so name the status instead.
        return { ...base, status: "failed", error: record.error?.message ?? "Workflow run failed" };
      case "cancelled":
        return { ...base, status: "cancelled" };
      default:
        return { ...base, status: record.status };
    }
  }

  /** Snapshot a run id, resolving undefined for one that does not exist. */
  async function snapshotById(runId: string): Promise<WorkflowRunSnapshot | undefined> {
    const record = await wdk.getRun(runId);
    return record ? await toSnapshot(record, undefined) : undefined;
  }

  return {
    async start(
      workflow: AnyWorkflowDef | string,
      input?: unknown,
      options?: StartOptions,
    ): Promise<string> {
      const { name, def } = resolve(workflow);
      const validated = await validate(name, def, input);
      const runId = await wdk.start(workflowIdOf(def), [validated]);
      if (options?.key !== undefined) {
        // A failed key write must not fail the `start`: the run is already
        // created and running, so throwing here would tell the caller nothing
        // happened while the work proceeds unreachably. Losing the index entry
        // costs a later `find`, which is recoverable; losing the runId the caller
        // was about to be handed is not.
        await keys.record(name, options.key, runId).catch((err: unknown) => {
          logger.warn?.("Workflow correlation key not recorded", {
            workflow: name,
            runId,
            error: errorMessage(err),
          });
        });
      }
      return runId;
    },

    get(runId: string): Promise<WorkflowRunSnapshot | undefined> {
      return snapshotById(runId);
    },

    async find(
      workflow: AnyWorkflowDef | string,
      key: string,
      options?: FindOptions,
    ): Promise<WorkflowRunSnapshot[]> {
      const { name } = resolve(workflow);
      const runIds = await keys.lookup(name, key, resolveFindLimit(options?.limit));
      const records = await mapInBatches(runIds, RUN_READ_CONCURRENCY, (id) => wdk.getRun(id));
      // A recorded id whose run is gone is dropped rather than reported: runs
      // expire, and a `find` that threw because one of five results had aged out
      // would be useless exactly when history matters. The key stays indexed —
      // sweeping it would need a second writer for no read it affects.
      return await mapInBatches(
        records.filter((r): r is WdkRunRecord => r !== undefined),
        RUN_READ_CONCURRENCY,
        (r) => toSnapshot(r, key),
      );
    },

    async recent(
      workflow: AnyWorkflowDef | string,
      options?: FindOptions,
    ): Promise<WorkflowRunSnapshot[]> {
      const { name } = resolve(workflow);
      const records = await wdk.listRuns(name, resolveFindLimit(options?.limit));
      return await mapInBatches(records, RUN_READ_CONCURRENCY, (r) => toSnapshot(r, undefined));
    },

    cancel(runId: string): Promise<boolean> {
      return wdk.cancel(runId);
    },

    wakeUp(runId: string, options?: WakeUpOptions): Promise<number> {
      // An empty `correlationIds` is passed through as "none named", not as an
      // empty target set: WDK reads a present-but-empty list as a filter that
      // matches nothing, so a caller building the array from a filter that
      // happened to yield nothing would silently wake nothing at all while
      // reading as "wake everything".
      const ids = options?.correlationIds;
      return wdk.wakeUp(runId, ids && ids.length > 0 ? ids : undefined);
    },

    stream(runId: string, options?: StreamOptions): Promise<ReadableStream<unknown>> {
      // Async to match every other method here even though WDK's own read is
      // synchronous — the laziness is what makes that free, and a uniform
      // surface is what lets `rejectingWorkflows` cover this with one rejector.
      return Promise.resolve(
        wdk.readStream(runId, {
          namespace: options?.namespace,
          startIndex: options?.startIndex,
        }),
      );
    },

    listing(): WorkflowSummary[] {
      return Object.entries(workflows).map(([name, def]) => ({
        name,
        ...(def.description !== undefined && { description: def.description }),
        // Converted here rather than stored, because the reader is a browser
        // rendering a form and a Standard Schema does not survive the wire.
        // A schema that cannot convert is omitted rather than fatal: the listing
        // is also what `workflow_status` reads, and a form that cannot be
        // rendered must not take the status tool down with it.
        ...(def.input !== undefined && { inputSchema: safeJsonSchema(def.input, name, logger) }),
      }));
    },
  } satisfies WorkflowClient as WorkflowClient;
}

/** Convert a declared input schema for the wire, warning rather than throwing. */
function safeJsonSchema(
  schema: NonNullable<WorkflowDef["input"]>,
  name: string,
  logger: Logger,
): unknown {
  try {
    return toToolJsonSchema(schema);
  } catch (err: unknown) {
    logger.warn?.("Workflow input schema could not be converted to JSON Schema", {
      workflow: name,
      error: errorMessage(err),
    });
  }
}

/** One message for both directions of `createWorkflowClient`'s name resolution. */
function unknownWorkflowMessage(named: string, declared: readonly string[]): string {
  const list = declared.length > 0 ? declared.join(", ") : "(none)";
  return `Workflow "${named}" is not declared on this agent. Declared workflows: ${list}.`;
}

/** Build the key store this runtime should use: the app database, or memory. */
export function resolveKeyStore(db: Db | undefined): WorkflowKeyStore {
  return db ? createPostgresKeyStore(db) : createMemoryKeyStore();
}
