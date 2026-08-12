// Copyright 2026 the AAI authors. MIT license.
/**
 * Continue-as-new: settling a run that called `ctx.continueAs` and minting its
 * successor.
 *
 * Its own module because `workflow-engine.ts` reached the 500-line cap, and this
 * is one decision with three ways to get it wrong — all three recorded below, and
 * none of them visible from the call site.
 */

import { errorMessage } from "../sdk/utils.ts";
import { MAX_CONTINUATIONS } from "../sdk/workflow-limits.ts";
import type { WorkflowStore } from "./workflow-store.ts";

/** What {@link createContinuation} needs from the engine. */
export type ContinuationDeps = {
  store: WorkflowStore;
  /** Validate an input against its workflow's schema — the engine's own. */
  validate(workflow: string, input: unknown): Promise<unknown>;
  /** Claim and run the successor. Not awaited by the caller. */
  execute(runId: string): void;
};

/**
 * Settle a run that called `ctx.continueAs`, and start its successor.
 *
 * Ordered successor-FIRST, deliberately: a crash between the two leaves this run
 * `running` with an expired lease, so recovery replays it and continues again —
 * one orphaned successor, which is at-least-once and consistent with every other
 * step here. The other order loses the work entirely, which is not.
 *
 * The correlation key is inherited, so `find` and the `workflow_status` builtin
 * follow the chain without the caller re-keying anything.
 */
export function createContinuation(deps: ContinuationDeps) {
  const { store, validate, execute } = deps;
  return async function continueRun(runId: string, input: unknown): Promise<void> {
    const row = await store.get(runId);
    if (!row) return;
    const depth = (await store.continuationDepth(runId)) + 1;
    if (depth > MAX_CONTINUATIONS) {
      // Failed rather than silently stopped: an unconditional `continueAs` is a
      // bug in the workflow, and a chain that just ended would look like a run
      // that finished successfully.
      await store.fail(
        runId,
        `workflow "${row.workflow}" continued ${MAX_CONTINUATIONS} times without finishing; ` +
          "`ctx.continueAs` needs a termination condition",
      );
      return;
    }
    // Validated HERE, and a rejection fails THIS run: the throw would otherwise
    // escape the engine's `settleFailure` — itself running from `execute`'s catch —
    // and leave the run `running` with a live lease, i.e. a handoff that silently
    // becomes an abandoned run recovery will replay. Catching it also puts the
    // error where an author can see it, rather than on the successor's first
    // replay, which would be a run that exists and can never make progress.
    let validated: unknown;
    try {
      validated = await validate(row.workflow, input);
    } catch (err) {
      await store.fail(runId, errorMessage(err));
      return;
    }
    const successor = crypto.randomUUID();
    // The owner is INHERITED. Without this the successor belongs to nobody: the
    // user who started the work stops seeing it mid-chain while an unscoped caller
    // starts to, which is a silent ownership change rather than a refusal.
    const owner = await store.ownerScope(runId);
    await store.create(successor, row.workflow, validated, row.key, depth, owner);
    // `completed`, not a status of its own: the run really is finished, and a
    // sixth status would have to be taught to `isTerminal`, the page's poll, the
    // builtin's report and the studio card — for a distinction only the output
    // carries. A caller polling the old id follows `continuedAs` instead.
    await store.complete(runId, { continuedAs: successor });
    execute(successor);
  };
}
