// Copyright 2026 the AAI authors. MIT license.
/**
 * Which run, and which step, is speaking — without threading either through
 * every signature.
 *
 * This is what replaced the Workflow DevKit's `getWritable()` and
 * `getStepMetadata()`, and the reason it has to exist rather than being replaced
 * by a parameter: `stepReport()` is called from deep inside a step's own helpers, and
 * `stepGenerate` reports progress from a module that has never heard of
 * workflows. Passing the run down to those call sites would mean every
 * intermediate function taking a context it does not use, which is the
 * situation `AsyncLocalStorage` exists for.
 *
 * ## The one property that makes it safe
 *
 * `AsyncLocalStorage` propagates across `await`, so a step's helpers land in the
 * step's own run even after several suspension points. It does NOT propagate out
 * of a callback the step scheduled and did not await — a `setTimeout` inside a
 * step body runs with no context — which is correct: work the step did not wait
 * for is not part of the step, and reporting it as such would attribute a chunk
 * to a run that had already ended.
 *
 * ## Absence is ordinary, and must not throw
 *
 * A step is also an ordinary exported async function — every workflow template's
 * tests call one directly, with no run anywhere. So {@link currentRun} answers
 * `undefined` rather than throwing, and `stepReport()` degrades to a log line. The
 * DevKit's `getStepMetadata()` threw here, which is why `workflow/report.ts`
 * used to carry a try/catch around it; it does not now.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { checkRuntimeInstance } from "../_instance-check.ts";

/** What is in scope while a workflow body, or one of its steps, runs. */
export type RunContext = {
  runId: string;
  /** The declared key the workflow was registered under. */
  workflow: string;
  /** Set only inside a step — a body itself is not one. */
  step?:
    | {
        name: string;
        /** `name#occurrence`, the journal key. */
        key: string;
        /** 1-based, and it counts attempts burned by failed boots. */
        attempt: number;
        /**
         * The ceiling this step was given — `StepOptions.maxAttempts`, or its
         * default.
         *
         * Here rather than left to the body to restate, because `isLastAttempt`
         * is the useful predicate and computing it from a hard-coded number is
         * two literals in two files with a silent failure between them: a body
         * that thinks attempt 3 is its last when the call site was given 5
         * degrades early on every run. See `stepInfo` in
         * `@alexkroman1/aai/step`.
         */
        maxAttempts: number;
        /**
         * The WALK's signal, aborted when this delivery is cancelled or the
         * caller hangs up — `undefined` for a walk that has none (a spec).
         *
         * Here rather than as a parameter to the step body for the reason the
         * module doc gives about `stepReport()`: `stepFetch` is reached from deep
         * inside a step's own helpers, and threading a signal down to it would
         * mean every intermediate function taking one it does not use. It is the
         * SAME signal `attemptLoop` classifies an abort against, which is what
         * makes an aborted request read as "the walk is over" rather than as the
         * step's own failure.
         *
         * A cancel could not reach a step's I/O at all before this: the body
         * received no signal, so a cancelled run went on uploading a recording
         * nobody was waiting for until the process died.
         */
        signal?: AbortSignal | undefined;
      }
    | undefined;
  /**
   * Append a progress chunk. Bound to this run by whoever entered the context.
   *
   * The namespace arrives UNRESOLVED — `streamNamespace` owns that, once, in
   * `workflow/streams.ts`. Taking a resolved string here is what produced four
   * resolutions under three rules, two of which disagreed about `""`.
   */
  write(namespace: string | undefined, value: unknown): Promise<number>;
};

/**
 * The one store for the process.
 *
 * Two stores would each see only their own `run()` calls, so a `stepReport()`
 * reaching the wrong one finds no context and degrades to log-only — a page
 * watching a fifty-minute transcription sees no progress at all. That is what a
 * deployed guest did while it held two copies of this package (the harness's
 * and an agent bundle's inlined one), and a `globalThis` slot papered over it.
 * There is one copy now — bundles IMPORT the runtime (`RUNTIME_EXTERNAL` in
 * aai-cli's `worker-bundler.ts`) — so a module-level store IS one per process;
 * `_instance-check.ts` warns when a process loads a second copy.
 */
const storage = new AsyncLocalStorage<RunContext>();
checkRuntimeInstance();

/**
 * The run in scope, or `undefined` outside one.
 *
 * @internal
 */
export function currentRun(): RunContext | undefined {
  return storage.getStore();
}

/**
 * Run `fn` with `context` in scope.
 *
 * @internal
 */
export function withRunContext<T>(context: RunContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(context, fn);
}

/**
 * Run `fn` with the current context NARROWED to one step.
 *
 * Enters a fresh context rather than mutating the outer one, so a step's
 * metadata cannot leak back into the body once the step resolves — the body
 * reports as the body again, which is what a reader of a run's history expects.
 * Outside a run this is a pass-through: a step called directly from a spec has
 * no context to narrow and must still work.
 *
 * @internal
 */
export function withStepContext<T>(
  step: NonNullable<RunContext["step"]>,
  fn: () => Promise<T>,
): Promise<T> {
  const outer = storage.getStore();
  if (!outer) return fn();
  return storage.run({ ...outer, step }, fn);
}

/**
 * The caller's signal, COMBINED with the walk's.
 *
 * The engine hands a step body no `AbortSignal` — deliberately, because the
 * step helpers are reached from inside a step's own helpers and a parameter
 * would have to be threaded through every one of them (see `RunContext["step"]`).
 * So the walk's signal is read out of the run context at the two places a
 * step's outbound I/O already goes through: `stepFetch`'s dispatcher and
 * `stepSpeak`'s socket.
 *
 * What it buys is that a CANCEL reaches a step's I/O. Without it a cancelled run
 * — or a delivery whose caller hung up — went on uploading a recording (or
 * synthesizing, billed, for up to `STEP_SPEAK_TIMEOUT_MS`) nobody was waiting
 * for, and `attemptLoop`'s abort arm could only unwind once the request it
 * could not see had finished.
 *
 * `AbortSignal.any` rather than replacing either: a caller's own deadline still
 * fires first, and sources are held weakly so there is no unlink bookkeeping.
 * Whichever source fires, the composite's `reason` IS that source's reason, so
 * `attemptLoop`'s `err === signal.reason` test still recognises a cancel.
 * Outside a run — a step called directly from a spec — there is no walk and the
 * caller's signal passes through untouched.
 *
 * @internal
 */
export function withWalkSignal(callerSignal: AbortSignal): AbortSignal;
/** A caller that passed no signal gets the walk's alone, or none. @internal */
export function withWalkSignal(callerSignal: AbortSignal | undefined): AbortSignal | undefined;
export function withWalkSignal(callerSignal: AbortSignal | undefined): AbortSignal | undefined {
  const walk = currentRun()?.step?.signal;
  if (!walk) return callerSignal;
  return callerSignal ? AbortSignal.any([callerSignal, walk]) : walk;
}
