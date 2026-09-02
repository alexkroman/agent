// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-runtime:workflow` epoch 2.
 *
 * A host IMPLEMENTING `WdkAdapter` — the engine the workflow client drives, in
 * a host's own store. `v1.ts` assembles the client's options and reads the
 * limits, which is the CALLER's half; this is the direction that actually
 * breaks, because an implementor owes every member of the interface where a
 * caller of the constants owes nothing. Written the way it was authored at
 * epoch 2, and it must keep compiling for as long as that epoch is advertised
 * as supported.
 *
 * ## What moved, and why epoch 2 survives it
 *
 * Epoch 3 added an optional `output` to `WdkRunRecord`: the run's result
 * carried on the record itself rather than fetched separately. Before it, the
 * only way to a finished run's value was `readOutput(runId)` — a second call
 * per run, which a listing of twenty runs cannot afford and so did not make,
 * leaving a page that lists completed runs unable to show what any of them
 * produced.
 *
 * Adding an OPTIONAL member to a type an implementor RETURNS is not breaking,
 * which is what makes this a retain: every record built below is still a legal
 * `WdkRunRecord`, and an adapter that carries no `output` is one whose callers
 * fall back to `readOutput` exactly as they did.
 *
 * **The two directions that WOULD break are both live here.** A new REQUIRED
 * method on `WdkAdapter`, or a new required FIELD on `WdkRunRecord`, reddens
 * this file immediately — an implementor gets no protection from optionality,
 * which is the whole reason the implementor side is the one worth freezing. It
 * is also why this file writes every member out longhand rather than spreading
 * a delegate: a spread would silently absorb a member added to the interface
 * and this example would stop being able to fail.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 2 has to be dropped with a reason.
 */

import {
  DEFAULT_WORKFLOW_FIND_LIMIT,
  ensureWorkflowJournalSchema,
  MAX_WORKFLOW_FIND_LIMIT,
  MAX_WORKFLOW_INPUT_BYTES,
  type WdkAdapter,
  type WdkRunRecord,
  type WdkStreamOptions,
} from "../../../runtime-barrel.ts";

/** What this host keeps per run, beyond what a caller may read back. */
type Run = {
  record: WdkRunRecord;
  args: unknown[];
  result: unknown;
  chunks: unknown[];
};

/**
 * ── EDIT: your own store. ────────────────────────────────────────────────
 *
 * In memory here so the example compiles with no database. The SHAPE is the
 * promise, not the storage — a real adapter puts each of these in a table and
 * `ensureWorkflowJournalSchema` below is what creates them.
 *
 * `byToken` is passed IN rather than owned, because the thing that MINTS a
 * webhook token is the runtime's own webhook path and not the adapter: the
 * adapter only has to be able to resolve one back to the run it belongs to.
 */
export function createExampleAdapter(byToken: Map<string, string>): WdkAdapter {
  const runs = new Map<string, Run>();

  /**
   * Clamp a caller's page size, in the adapter and not only at the door.
   *
   * Both numbers come from the package rather than being restated: a host
   * that invents its own ceiling accepts a limit the HTTP API then refuses, or
   * refuses one it would have allowed, and either way the disagreement
   * surfaces as a listing that fails for no reason the caller can see.
   */
  const clamp = (limit: number): number =>
    Math.min(
      Math.max(1, Math.floor(limit) || DEFAULT_WORKFLOW_FIND_LIMIT),
      MAX_WORKFLOW_FIND_LIMIT,
    );

  return {
    /**
     * Begin a run and return its id, without waiting for it.
     *
     * The input bound is checked HERE and against the package's constant: the
     * arguments cross a queue between the start and the first step, so a
     * payload the store accepts and the engine cannot carry is a run that dies
     * after being reported as started.
     */
    async start(workflowId, args) {
      if (JSON.stringify(args).length > MAX_WORKFLOW_INPUT_BYTES) {
        throw new Error("Workflow input too large.");
      }
      const runId = `run_${runs.size + 1}`;
      runs.set(runId, {
        record: {
          runId,
          workflowName: workflowId,
          status: "pending",
          // `Date | number` on the type, because a store hands back whichever
          // its driver gives: a Postgres `timestamptz` arrives as a `Date`, an
          // in-memory one as epoch millis, and neither should have to convert.
          createdAt: Date.now(),
          error: undefined,
        },
        args: [...args],
        result: undefined,
        chunks: [],
      });
      return runId;
    },

    /** One run, or `undefined` — never a throw: an unknown id is a 404. */
    async getRun(runId) {
      return runs.get(runId)?.record;
    },

    /** Newest first, bounded. */
    async listRuns(workflowId, limit) {
      return [...runs.values()]
        .filter((run) => run.record.workflowName === workflowId)
        .reverse()
        .slice(0, clamp(limit))
        .map((run) => run.record);
    },

    /**
     * Ask a run to stop, and say whether a run was there to stop.
     *
     * `false` for an already-finished run rather than a throw, because cancel
     * is what a caller retries: a second cancel arriving after the first
     * landed is the normal case, not an error.
     */
    async cancel(runId) {
      const run = runs.get(runId);
      if (run?.record.status !== "pending") return false;
      run.record = { ...run.record, status: "cancelled" };
      return true;
    },

    /**
     * Wake the sleeps a run is parked on, and return how many woke.
     *
     * `undefined` correlation ids means ALL of them — the shape a redeploy
     * needs, where the caller knows the run should move and not which wait it
     * is sitting in.
     */
    async wakeUp(runId, correlationIds) {
      const run = runs.get(runId);
      if (!run) return 0;
      return correlationIds ? correlationIds.length : 1;
    },

    /**
     * Deliver a webhook payload against the TOKEN, never the run id.
     *
     * The token is the capability: it is what a step handed a third party, so
     * it is the only name that side knows and the only one it may be trusted
     * with. Resolving a run id from a caller-supplied string would let anyone
     * who can guess `run_2` settle somebody else's wait.
     */
    async signal(token, payload) {
      const runId = byToken.get(token);
      if (!runId) return false;
      runs.get(runId)?.chunks.push(payload);
      return true;
    },

    /**
     * The progress stream a page renders, from `startIndex` on.
     *
     * Synchronous by contract — it returns the stream, not a promise of one —
     * so a caller can attach before the first chunk exists. `namespace`
     * selects which of a run's streams: a body may `emit` into several.
     */
    readStream(runId, options: WdkStreamOptions) {
      const from = options.startIndex ?? 0;
      const chunks = (runs.get(runId)?.chunks ?? []).slice(from);
      return new ReadableStream<unknown>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      });
    },

    /**
     * How many chunks exist, so a reconnecting page knows where to resume.
     *
     * ONE PAST THE LAST, which is what `startIndex` expects — a count and a
     * cursor are the same number only while the stream has no holes.
     */
    async streamTail(runId, _options) {
      return runs.get(runId)?.chunks.length ?? 0;
    },

    /**
     * The finished run's value, fetched on its own.
     *
     * At this epoch this is the ONLY way to a result, which is the gap epoch 3
     * closed by putting an optional `output` on the record: a listing cannot
     * make one of these calls per run.
     */
    async readOutput(runId) {
      return runs.get(runId)?.result;
    },
  };
}

/**
 * Create the journal's tables, when this deployment owns its database.
 *
 * A no-op with no `DATABASE_URL`: the adapter above keeps its runs in memory
 * and there is nothing to create. The reason this is public at all is that the
 * applier existed from the start with no production caller, so a self-hosted
 * deployment logged `runStore: "postgres"` at boot and then died on its first
 * run with `42P01 relation "aai_workflow_runs" does not exist` — the boot line
 * claimed durable and nothing was.
 */
export async function ensureSchema(url: string | undefined): Promise<boolean> {
  if (!url) return false;
  return await ensureWorkflowJournalSchema({ url, logger: console });
}
