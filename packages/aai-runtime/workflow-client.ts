// Copyright 2026 the AAI authors. MIT license.
/**
 * `ctx.workflows` — the {@link WorkflowClient} implementation, over whatever
 * engine {@link WdkAdapter} is backed by.
 *
 * There is no engine in this file and there is not meant to be one. Every method
 * is a translation between the authoring vocabulary and the adapter's:
 *
 * | ours | adapter |
 * | --- | --- |
 * | `start(def, input, { key })` | `start(name, [input])` + our key index |
 * | `get(runId)` | `getRun(runId)` |
 * | `find(def, key)` | key index → `getRun` per id |
 * | `recent(def)` | `listRuns(name)` |
 * | `cancel(runId)` | `cancel(runId)` |
 * | `wakeUp(runId)` | `wakeUp(runId)` |
 * | `stream(runId)` | `readStream(runId)` |
 * | `listing()` | the declared `workflows` record |
 *
 * That the adapter is injected rather than imported is what lets this module be
 * specified with no engine, no journal and no database — `workflow-client.test.ts`
 * passes a fake, and `eval/workflow-engine.ts` passes an in-process one.
 *
 * ## A workflow has ONE name now
 *
 * This section used to be titled "the two vocabularies use the word name for
 * different strings", and deleting it is the visible half of removing the
 * Workflow DevKit. A run record's `workflowName` was the COMPILER's identifier —
 * `workflow//./workflows/digest//digestFlow`, which the DevKit's own docs call
 * machine-readable — while ours was the key in `agent({ workflows })`. Both
 * directions of that translation had been missing, and each was silent in its
 * own way: `recent` filtered by the declared name, which matched no stored run,
 * so it answered `[]` for every workflow and took `GET /workflows/runs` and
 * `aai workflow runs <name>` with it; while every snapshot reported the machine
 * id as its `workflow`, which a status tool reads to a caller down the phone.
 *
 * The engine now records a run under the declared name, so there is one string,
 * `nameByDef` is the only index, and neither bug is representable. What remains
 * is the reason the mapping is by IDENTITY rather than a `name` field on the def
 * — see `resolve`.
 */

import {
  formatSchemaIssues,
  PUBLIC_URL_UNCONFIGURED_MESSAGE,
  toToolJsonSchema,
} from "@alexkroman1/aai/host-internal";
import type { Db } from "@alexkroman1/aai/internal";
import { mapConcurrent } from "@alexkroman1/aai/step";
import { errorMessage, omitUndefined } from "@alexkroman1/aai/utils";
import type {
  AnyWorkflowDef,
  FindOptions,
  StartOptions,
  StreamOptions,
  WakeUpOptions,
  WorkflowClient,
  WorkflowDef,
  WorkflowRunSnapshot,
  WorkflowSummary,
} from "@alexkroman1/aai/workflow-api";
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
   * The index over `agent({ workflows })`: a def to the key it is declared
   * under.
   *
   * FIRST key wins, matching `Object.entries` order — the same def declared
   * under two keys is legitimate (see `resolve`) and a run of it carries no
   * trace of which one a caller meant, so the choice has to be deterministic.
   *
   * **There used to be a second index here, and its disappearance is the shape
   * of the DevKit removal.** A workflow had two identities: the key an author
   * declared it under, and the `workflowId` a compile-time transform stamped
   * onto the body (`workflow//{file}//{export}`). Everything downstream — the
   * run record's `workflowName`, `listRuns`'s filter — spoke the second one, so
   * this map existed to translate back. The engine now takes the declared name
   * directly, the two identities are one, and the translation is gone with it.
   */
  const nameByDef = new Map<AnyWorkflowDef, string>();
  for (const [name, def] of Object.entries(workflows)) {
    if (!nameByDef.has(def)) nameByDef.set(def, name);
  }

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
    const name = nameByDef.get(workflow);
    const declared = name === undefined ? undefined : workflows[name];
    if (name !== undefined && declared) return { name, def: declared };
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
      workflow: record.workflowName,
      createdAt: new Date(record.createdAt).getTime(),
      ...omitUndefined({ key }),
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
      const runId = await wdk.start(name, [validated]);
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
      const records = await mapConcurrent(runIds, RUN_READ_CONCURRENCY, (id) => wdk.getRun(id));
      // A recorded id whose run is gone is dropped rather than reported: runs
      // expire, and a `find` that threw because one of five results had aged out
      // would be useless exactly when history matters. The key stays indexed —
      // sweeping it would need a second writer for no read it affects.
      return await mapConcurrent(
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
      const { name } = resolve(workflow);
      const records = await wdk.listRuns(name, resolveFindLimit(options?.limit));
      return await mapConcurrent(records, RUN_READ_CONCURRENCY, (r) => toSnapshot(r, undefined));
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

    async lastLine(runId: string, options?: StreamOptions): Promise<unknown | undefined> {
      const opts = streamOptions(options);
      // The tail FIRST, and never conditionally: a progress channel is never
      // closed, so a stream with nothing in it does not end — it waits. This
      // is the whole reason the method exists rather than being composed at
      // each call site. See `WorkflowClient.lastLine`.
      const tail = await wdk.streamTail(runId, opts);
      if (tail < 0) return undefined;
      // A non-negative `startIndex` is a floor the caller has already read
      // past; a negative one already means "from the end", which is where this
      // reads from regardless.
      const floor = opts.startIndex;
      if (floor !== undefined && floor >= 0 && tail < floor) return undefined;
      // `-1` is the last chunk alone — the alternative replays the whole log to
      // throw all but its final entry away.
      const stream = wdk.readStream(runId, { ...opts, startIndex: -1 });
      // Returning from inside `for await` cancels the reader, so the one chunk
      // is read and nothing is left draining.
      for await (const chunk of stream) return chunk;
      return undefined;
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
        ...omitUndefined({
          description: def.description,
          // Converted here rather than stored, because the reader is a browser
          // rendering a form and a Standard Schema does not survive the wire.
          // A schema that cannot convert is omitted rather than fatal: the
          // listing is also what `workflow_status` reads, and a form that cannot
          // be rendered must not take the status tool down with it. `def.input &&`
          // rather than a bare call: the guard is what makes the argument
          // present, so it stays in front of it.
          inputSchema: def.input && safeJsonSchema(def.input, name, logger),
          // Forwarded rather than derived: which properties are uploads is the
          // author's declaration, and the page is the reader that acts on it.
          uploads: def.uploads,
        }),
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
