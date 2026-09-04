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
 * DevKit's `getStepMetadata()` threw here, which is why `workflow-report.ts`
 * used to carry a try/catch around it; it does not now.
 */

import { AsyncLocalStorage } from "node:async_hooks";

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
   * `workflow-streams.ts`. Taking a resolved string here is what produced four
   * resolutions under three rules, two of which disagreed about `""`.
   */
  write(namespace: string | undefined, value: unknown): Promise<number>;
};

/**
 * The one store for the process — and "the process" needs saying carefully.
 *
 * Two stores would each see only their own `run()` calls, so a `stepReport()`
 * reaching the wrong one finds no context and degrades to log-only. This module
 * said that and then took a module-level `new AsyncLocalStorage()`, which is one
 * store per COPY of this package rather than one per process.
 *
 * **A deployed guest has two copies**, and that is by design rather than by
 * accident: the harness bundles its own `aai-runtime` and calls `createServer`
 * from it, while the agent's runtime is built by the BUNDLE's own
 * `__aaiCreateRuntime` so a deployed agent runs the SDK version it was tested
 * against (`packages/aai-guest/CLAUDE.md`, "User-shipped runtime"). So the
 * reporter `installWorkflowSupport` publishes belonged to the harness's copy and
 * the run context belonged to the bundle's, and every `stepReport()` from inside a
 * step logged its line with an empty context and streamed NOTHING — a page
 * watching a fifty-minute transcription saw no progress at all, and the attempt
 * suffix that tells a reader a fan-out is retrying never appeared.
 *
 * It survived the DevKit because the arms this replaced — `getStepMetadata` and
 * `getWritable` — came from the `workflow` package, which resolved ONCE from the
 * guest image's `node_modules` and was shared by both copies. Removing them made
 * the store's own warning come true.
 *
 * `Symbol.for` on `globalThis` is the same mechanism the step reporter slot
 * already uses one module over (`sdk/step-report.ts`), and for the same reason:
 * a cross-copy rendezvous is the only kind that works here.
 */
type RunContextSlot = { [RUN_CONTEXT_SLOT]?: AsyncLocalStorage<RunContext> };
const RUN_CONTEXT_SLOT = Symbol.for("@alexkroman1/aai-runtime.workflowRunContext");

// Not `??=`: an assignment inside an expression is a lint error here, and the
// two-step form reads as what it is — adopt the store a sibling copy already
// registered, or be the copy that registers it.
const slot = globalThis as RunContextSlot;
slot[RUN_CONTEXT_SLOT] ??= new AsyncLocalStorage<RunContext>();
const storage: AsyncLocalStorage<RunContext> = slot[RUN_CONTEXT_SLOT];

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
