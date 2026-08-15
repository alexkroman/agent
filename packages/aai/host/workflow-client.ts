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
 * | `recent(def)` | `world.runs.list({ workflowName: workflowId })` |
 * | `cancel(runId)` | `getRun(runId).cancel()` |
 * | `wakeUp(runId)` | `getRun(runId).wakeUp()` |
 * | `stream(runId)` | `getRun(runId).getReadable()` |
 * | `listing()` | the declared `workflows` record |
 *
 * Two translations are worth reading before changing them: the name mapping,
 * which is what makes a rename a one-place change, and the snapshot mapping,
 * which is where WDK's run record becomes a discriminated union.
 *
 * ## The two vocabularies use the word "name" for different strings
 *
 * A run record's `workflowName` is the COMPILER's identifier —
 * `workflow//./workflows/digest//digestFlow`, the same string as `workflowId`,
 * which the DevKit's own docs call machine-readable and hand to
 * `parseWorkflowName()` before showing anyone. Ours is the key in
 * `agent({ workflows })`, which is what `WorkflowRunBase.workflow` promises and
 * what `find` indexes keys under.
 *
 * Both directions of that translation were missing, and each was silent in its
 * own way: `recent` filtered `world.runs.list` by the DECLARED name, which
 * matches no stored run, so it answered `[]` for every workflow — taking
 * `GET /workflows/runs` and `aai workflow runs <name>` ("No runs of X yet") with
 * it — while every snapshot reported the machine id as its `workflow`, which
 * `research-workflow`'s status tool reads to a caller down the phone. Neither could
 * be caught by this module's own specs, because a stubbed adapter answers with
 * whatever name the test wrote; {@link WdkAdapter}'s `listRuns` therefore names
 * its parameter `workflowId`, and the fake in `workflow-client.test.ts` stores
 * runs under it.
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
import {
  MISSING_WORKFLOW_ID_MESSAGE,
  PUBLIC_URL_UNCONFIGURED_MESSAGE,
} from "../sdk/workflow-unavailable.ts";
import { WorkflowRequestError } from "./_workflow-request-error.ts";
import type { Logger } from "./runtime-config.ts";
import {
  createMemoryKeyStore,
  createPostgresKeyStore,
  resolveFindLimit,
  type WorkflowKeyStore,
} from "./workflow-keys.ts";
import { WORKFLOW_WEBHOOK_PREFIX } from "./workflow-serve.ts";
import type { WdkAdapter, WdkRunRecord, WdkStreamOptions } from "./workflow-wdk-types.ts";

// The WDK seam's types live next door and are re-exported here, because this is
// the module whose parameter they are and the one `/runtime` publishes them from.
export type { WdkAdapter, WdkRunRecord, WdkStreamOptions } from "./workflow-wdk-types.ts";

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
  /**
   * This agent's own public base URL — origin plus, on the platform, the slug.
   * The only thing `publicWebhookUrl` can be built from; absent, it throws.
   *
   * Passed in rather than read from the environment, because the SDK must not
   * know the platform's vocabulary: `AAI_PUBLIC_BASE_URL` is a boot key of the
   * harness↔bundle contract, and sniffing it here would make the SDK's behaviour
   * depend on a variable only one of its three deployments sets.
   */
  publicUrl?: string | undefined;
  logger: Logger;
};

/**
 * Create the client tool code sees as `ctx.workflows`.
 *
 * @internal
 */
export function createWorkflowClient(opts: WorkflowClientOptions): WorkflowClient {
  const { workflows, keys, wdk, publicUrl, logger } = opts;

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
      if (!def)
        throw new WorkflowRequestError(unknownWorkflowMessage(workflow, Object.keys(workflows)));
      return { name: workflow, def };
    }
    for (const [name, def] of Object.entries(workflows)) {
      if (def === workflow) return { name, def };
    }
    // A def that is not in the record cannot be started: nothing maps it to a
    // name, so a run of it could never be found again. The message names the
    // declared set because the usual cause is a workflow written and not wired
    // into `agent({ workflows })`.
    throw new WorkflowRequestError(
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
      throw new WorkflowRequestError(
        `Invalid input for workflow "${name}": ${formatSchemaIssues(result.issues)}`,
      );
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
   * `workflowId` → the key it is declared under: `resolve`'s mapping, run the
   * other way for the run records WDK hands back.
   *
   * Built once from the same record, so a name reported on a snapshot is by
   * construction one `resolve` accepts. FIRST key wins, matching `resolve`'s own
   * `Object.entries` order — the same def declared under two keys is legitimate
   * (see `resolve`), and a run of it carries no trace of which one a caller
   * meant, so one of them has to be picked and it may as well be the one listed
   * first.
   *
   * A def the compiler never transformed contributes nothing rather than
   * throwing: `start` is where that build failure is reported, and a client that
   * could not even be CONSTRUCTED for it would take the other workflows' reads
   * down with it.
   */
  const declaredNameById = new Map<string, string>();
  for (const [name, def] of Object.entries(workflows)) {
    const id = def.run.workflowId;
    if (id !== undefined && !declaredNameById.has(id)) declaredNameById.set(id, name);
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
      // The declared key, which is what `WorkflowRunBase.workflow` promises.
      // A run of a workflow this agent no longer declares (renamed, removed, or
      // read by id from another deployment) keeps the raw identifier: it is the
      // only true thing left to say, and it is still the string
      // `parseWorkflowName` takes.
      workflow: declaredNameById.get(record.workflowName) ?? record.workflowName,
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
      // The workflowId, not the name — see the module doc's second half. `find`
      // reads OUR key index and so takes the declared name; this one reads
      // WDK's own store and so takes WDK's own identifier.
      const { def } = resolve(workflow);
      const records = await wdk.listRuns(workflowIdOf(def), resolveFindLimit(options?.limit));
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

    signal(token: string, payload?: unknown): Promise<boolean> {
      // `payload` defaults to `{}` rather than passing `undefined` through: a
      // hook resolves WITH its payload, so a body awaiting one and reading a
      // field off it would throw on a signal sent for its arrival alone. An
      // empty object is the "I am only telling you it happened" value, and it
      // survives the serialization a hook payload crosses.
      return wdk.signal(token, payload ?? {});
    },

    streamTail(runId: string, options?: StreamOptions): Promise<number> {
      return wdk.streamTail(runId, streamOptions(options));
    },

    stream(runId: string, options?: StreamOptions): Promise<ReadableStream<unknown>> {
      // Async to match every other method here even though WDK's own read is
      // synchronous — the laziness is what makes that free, and a uniform
      // surface is what lets `rejectingWorkflows` cover this with one rejector.
      return Promise.resolve(wdk.readStream(runId, streamOptions(options)));
    },

    publicWebhookUrl(token: string): string {
      // Trimmed and de-slashed here rather than at every caller: the value
      // arrives from a boot env var, a container's `PUBLIC_URL`, or an author's
      // own string, and a copied-in origin ending in `/` is the ordinary shape of
      // all three. NOT a `WorkflowRequestError` — that class is for something the
      // model can recover from by asking differently, and no rewording of a tool
      // call configures a deployment.
      const base = publicUrl?.trim().replace(/\/+$/, "");
      if (!base) throw new Error(PUBLIC_URL_UNCONFIGURED_MESSAGE);
      if (token === "") throw new WorkflowRequestError("A webhook token cannot be empty.");
      // `workflow-serve.ts`'s prefix, which is also what `webhookToken` parses
      // and what the platform's proxy route derives from, so the URL handed out
      // and the path answering it cannot drift. Encoded for the reason that
      // parser decodes: the route is ONE segment.
      return `${base}${WORKFLOW_WEBHOOK_PREFIX}${encodeURIComponent(token)}`;
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
        // Forwarded rather than derived: which properties are uploads is the
        // author's declaration, and the page is the reader that acts on it.
        ...(def.uploads !== undefined && { uploads: def.uploads }),
      }));
    },
  } satisfies WorkflowClient as WorkflowClient;
}

/** One spelling of the stream options both read methods pass through. */
function streamOptions(options: StreamOptions | undefined): WdkStreamOptions {
  return { namespace: options?.namespace, startIndex: options?.startIndex };
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
