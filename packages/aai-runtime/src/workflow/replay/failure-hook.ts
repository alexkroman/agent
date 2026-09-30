// Copyright 2026 the AAI authors. MIT license.
/**
 * Running `workflow({ onFailure })` — the SDK's `sdk/workflow-failure.ts`
 * argues why the ENGINE runs it rather than a body-wide `catch`.
 *
 * `workflow/replay.ts` calls this once `classifyThrow` has said the body's throw
 * is the RUN failing: not a suspension, not the caller's abort, not a journal
 * failure (all three re-throw before this), and not a divergence refusal (the
 * caller skips those — a walk that has lost its place in the journal would be
 * refused again at the hook's own step). The hook is ONE step on the same
 * walk's `ctx`, named `onFailure`, so a redelivery that replays to the same
 * failure answers it from the journal rather than announcing twice.
 *
 * What it does NOT decide is the run's status: the original failure is what is
 * recorded, whatever the hook did. A hook that throws past its retries is
 * logged and swallowed, EXCEPT the two throws that are not the hook's to
 * swallow — the walk's own abort (a cancel landing during the hook) and a
 * journal failure — which the caller re-raises exactly as it would have for
 * the body.
 */

import {
  asFailureError,
  type PollHost,
  type ResolvedFailureHandler,
} from "@alexkroman1/aai/host-internal";
import { errorMessage } from "@alexkroman1/aai/utils";
import type { Logger } from "../../runtime-config.ts";

/** What one hook run needs. */
export type FailureHookRun = {
  handler: ResolvedFailureHandler | undefined;
  /** What the body threw. */
  error: unknown;
  runId: string;
  workflow: string;
  input: Record<string, unknown>;
  /** The walk's own `ctx`: the hook is a step on it, name unconstrained. */
  host: PollHost;
  signal: AbortSignal | undefined;
  logger?: Logger | undefined;
};

/**
 * Run the hook as the `onFailure` step. Resolves once it settled either way;
 * re-throws only the walk's own abort.
 */
async function runFailureHook(
  run: FailureHookRun & { handler: ResolvedFailureHandler },
): Promise<void> {
  const { handler, runId, workflow, input } = run;
  try {
    await run.host.step(
      "onFailure",
      () => handler.run(asFailureError(run.error), { runId, workflow, input }),
      { maxAttempts: handler.maxAttempts },
    );
  } catch (err: unknown) {
    if (run.signal?.aborted && err === run.signal.reason) throw err;
    run.logger?.warn?.("Workflow onFailure hook failed; recording the run's own failure", {
      runId,
      workflow,
      error: errorMessage(err),
    });
  }
}

/**
 * `replay.ts`'s one call: run the hook when the walk's outcome is the RUN
 * failing — a `failed` outcome that is not a divergence refusal, on a workflow
 * that declared one — then re-raise a journal failure the hook's own step hit,
 * which is the delivery's to retry exactly as the body's would have been.
 *
 * @internal
 */
export async function afterRunFailed(
  outcome: { kind: string },
  refused: string | undefined,
  journalFailure: () => unknown,
  run: FailureHookRun,
): Promise<void> {
  const { handler } = run;
  if (outcome.kind !== "failed" || refused !== undefined || handler === undefined) return;
  await runFailureHook({ ...run, handler });
  const failure = journalFailure();
  if (failure !== undefined) throw failure;
}
