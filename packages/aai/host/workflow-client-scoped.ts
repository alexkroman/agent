// Copyright 2026 the AAI authors. MIT license.
/**
 * The `WorkflowClient` surface, bound to ONE caller's identity.
 *
 * Split from `workflow-engine.ts` when it reached the 500-line cap, on the seam the
 * scoping introduced: everything left there is about the run COLLECTION — claiming,
 * leases, wake timers, recovery — and this is the per-caller view of it.
 *
 * A factory rather than one object plus per-call arguments, because the scope is a
 * property of the CALLER and not of the call: threading it through every
 * `ctx.workflows` signature would put an authorization parameter on the authoring
 * API, where an author could pass the wrong one — or omit it and silently widen.
 * The API builds one per request from `identify`; tool code gets the unscoped one,
 * because a run started from a session belongs to the app.
 *
 * @internal
 */

import type { ToolInputSchema } from "../sdk/schema.ts";
import type {
  AnyWorkflowDef,
  FindOptions,
  StartOptions,
  WorkflowDef,
  WorkflowRunSnapshot,
  WorkflowSummary,
} from "../sdk/workflow.ts";
import type { ScopedWorkflowEngine } from "./workflow-engine.ts";
import { clampFindLimit } from "./workflow-engine-limits.ts";
import { wrapSignal } from "./workflow-execution.ts";
import type { WorkflowStore } from "./workflow-store.ts";

/** What one scoped client needs from the engine around it. */
export type ScopedClientDeps = {
  workflows: Readonly<Record<string, WorkflowDef>>;
  store: WorkflowStore;
  /** The caller's identity, or undefined for the app itself and the operator. */
  scope: string | undefined;
  resolveName: (workflow: WorkflowDef | string) => string;
  validate: (name: string, def: WorkflowDef, input: unknown) => Promise<unknown>;
  ensureTables: () => Promise<void>;
  executeDetached: (runId: string) => void;
  controllers: Map<string, AbortController>;
};

export function buildScopedClient(deps: ScopedClientDeps): ScopedWorkflowEngine {
  const {
    workflows,
    store,
    scope,
    resolveName,
    validate,
    ensureTables,
    executeDetached,
    controllers,
  } = deps;
  return {
    async start<P extends ToolInputSchema, R>(
      workflow: WorkflowDef<P, R> | string,
      input?: unknown,
      options?: StartOptions,
    ): Promise<string> {
      const name = resolveName(workflow as WorkflowDef | string);
      // Non-null: `resolveName` only returns a name the record holds.
      const def = workflows[name] as WorkflowDef;
      const validated = await validate(name, def, input);
      await ensureTables();
      const runId = crypto.randomUUID();
      // The scope is stamped at creation and never mutable afterwards: a run's
      // owner is decided by whoever started it.
      await store.create(runId, name, validated, options?.key, 0, scope);
      // Deliberately not awaited — `start` resolves as soon as the run is
      // durable, which is the whole point: the caller is a tool answering a
      // turn, and the run outlives it. Failures are journaled by `execute`,
      // so what `executeDetached` catches is only a rejection it could not record.
      executeDetached(runId);
      return runId;
    },

    // `_of` is type-only: it exists so `output` on a completed run is the
    // workflow's own return type rather than `unknown`. The run's stored row is
    // what says which workflow it belongs to, so nothing reads the argument.
    async get<R>(
      runId: string,
      _of?: AnyWorkflowDef<R>,
    ): Promise<WorkflowRunSnapshot<R> | undefined> {
      await ensureTables();
      return (await store.get(runId, scope)) as WorkflowRunSnapshot<R> | undefined;
    },

    async find<R>(
      workflow: AnyWorkflowDef<R> | string,
      key: string,
      options?: FindOptions,
    ): Promise<WorkflowRunSnapshot<R>[]> {
      const name = resolveName(workflow as WorkflowDef | string);
      await ensureTables();
      return (await store.findByKey(
        name,
        key,
        clampFindLimit(options?.limit),
        scope,
      )) as WorkflowRunSnapshot<R>[];
    },

    async recent<R>(
      workflow: AnyWorkflowDef<R> | string,
      options?: FindOptions,
    ): Promise<WorkflowRunSnapshot<R>[]> {
      const name = resolveName(workflow as WorkflowDef | string);
      await ensureTables();
      return (await store.recent(
        name,
        clampFindLimit(options?.limit),
        scope,
      )) as WorkflowRunSnapshot<R>[];
    },

    async retry(runId: string): Promise<boolean> {
      await ensureTables();
      const revived = await store.retry(runId, scope);
      // Executed straight away rather than left to the next `runDue()`: an
      // operator pressing Retry is asking for it now, and the run is `pending`
      // with no lease, so this claim is uncontended. Not awaited, for the same
      // reason `start` does not await — the caller wants the acknowledgement, not
      // the outcome.
      if (revived) executeDetached(runId);
      return revived;
    },

    async signal(token: string, payload: unknown): Promise<string | undefined> {
      await ensureTables();
      // The payload is WRAPPED, because a caller's payload may itself be a string
      // — the same shape `park` records as "still waiting" — so the two journal
      // states have to be told apart by structure. `wrapSignal` is the one place
      // that shape is minted.
      const runId = await store.signal(token, wrapSignal(payload));
      // Executed straight away for the same reason `retry` is: the signal is
      // somebody waiting on an answer, and the run is `pending` with no lease.
      if (runId !== undefined) executeDetached(runId);
      return runId;
    },

    async cancel(runId: string): Promise<boolean> {
      await ensureTables();
      const stopped = await store.cancel(runId, scope);
      // Aborted unconditionally, not only when this call is what stopped it:
      // another replica may have cancelled the run, and this process holds the
      // only handle that can reach its `ctx.signal`.
      controllers.get(runId)?.abort();
      return stopped;
    },

    async putBlob(contentType: string, base64: string): Promise<string> {
      await ensureTables();
      const blobId = crypto.randomUUID();
      await store.putBlob(blobId, contentType, base64);
      return blobId;
    },
    /**
     * The DECLARED workflows, which are the app's and not a user's — so this is
     * identical on every scoped client. Present here because it is part of
     * `WorkflowClient`, not because a scope could change it.
     */
    listing(): WorkflowSummary[] {
      return Object.entries(workflows).map(([name, def]) =>
        def.description === undefined ? { name } : { name, description: def.description },
      );
    },
  };
}
