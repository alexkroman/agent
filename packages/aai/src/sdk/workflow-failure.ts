// Copyright 2026 the AAI authors. MIT license.
/**
 * `workflow({ onFailure })` — what a run does when it fails for good, before
 * the failure is recorded.
 *
 * A workflow that reports its result somewhere (says it on a speaker, texts
 * it, posts it) owes the same channel its failure, or a failed run is silence.
 * Every such app wrapped its whole body in the same `try { … } catch (err) {
 * await ctx.step("announceFailure", …); throw err; }`, and the wrapper had a
 * trap in it: a `catch` in a body also sees what is not the run's failure — a
 * journal outage the engine will retry, a cancel — so the announcement could go
 * out for a run that then resumed and succeeded. The engine knows which throws
 * are terminal; the body does not.
 *
 * So the hook runs where that is decided: once the engine has classified the
 * body's throw as the RUN failing (not a suspension, a cancel, a journal
 * failure or a divergence refusal), as a journaled step named `onFailure`, and
 * the failure is recorded after it. A redelivery that replays to the same
 * failure answers the step from the journal rather than announcing twice.
 *
 * Declared in its own module beside `workflow.ts`, which re-exports the types.
 */

import { DEFAULT_STEP_MAX_ATTEMPTS } from "./workflow-ctx-options.ts";

/**
 * What an `onFailure` hook is told about the run that failed.
 *
 * @public
 */
export type WorkflowFailureContext<I = unknown> = {
  /** The failed run's id — the same value `ctx.runId` had. */
  readonly runId: string;
  /** Key the workflow is declared under in `agent({ workflows })`. */
  readonly workflow: string;
  /** The run's validated input. */
  readonly input: I;
};

/**
 * A workflow's failure hook: runs as ONE step, with the error the body threw.
 * Whatever it returns is discarded; if it throws past its retries the hook's
 * failure is logged and the RUN's failure is still what is recorded.
 *
 * @public
 */
export type WorkflowFailureHook<I = unknown> = (
  error: Error,
  context: WorkflowFailureContext<I>,
) => Promise<void> | void;

/**
 * `WorkflowDef.onFailure`: the hook alone, or the hook with the step's
 * `maxAttempts` (a device announcement wants `DEFAULT_CLIENT_DELIVERY_ATTEMPTS`).
 *
 * @public
 */
export type WorkflowFailureHandler<I = unknown> =
  | WorkflowFailureHook<I>
  | {
      /** The hook. */
      run: WorkflowFailureHook<I>;
      /** The hook step's `maxAttempts`. Defaults to `DEFAULT_STEP_MAX_ATTEMPTS`. */
      maxAttempts?: number | undefined;
    };

/**
 * A declared handler, normalized — what a host runs.
 *
 * @internal
 */
export type ResolvedFailureHandler = {
  run: WorkflowFailureHook<Record<string, unknown>>;
  maxAttempts: number;
};

/**
 * Normalize `def.onFailure`, or `undefined` when there is none.
 *
 * The input is widened to a record here, at the one place a host takes the hook
 * off its typed declaration: the engine hands it the stored input the body got.
 *
 * @internal
 */
export function resolveFailureHandler(
  handler: WorkflowFailureHandler<never> | undefined,
): ResolvedFailureHandler | undefined {
  if (handler === undefined) return undefined;
  const { run, maxAttempts } = typeof handler === "function" ? { run: handler } : handler;
  return {
    // The hook was declared against the workflow's own input type, which the
    // engine's stored input IS (it was validated at start) — `never` is what lets
    // every declaration's hook reach here without a cast per workflow.
    run: run as WorkflowFailureHook<Record<string, unknown>>,
    maxAttempts: maxAttempts ?? DEFAULT_STEP_MAX_ATTEMPTS,
  };
}

/**
 * The thrown value as an `Error`, for the hook's first argument.
 *
 * @internal
 */
export function asFailureError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(typeof err === "string" ? err : String(err));
}
