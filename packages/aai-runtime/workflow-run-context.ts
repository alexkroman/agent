// Copyright 2026 the AAI authors. MIT license.
/**
 * Which run, and which step, is speaking — without threading either through
 * every signature.
 *
 * This is what the Workflow DevKit's `getWritable()` and `getStepMetadata()`
 * read, and the reason it has to exist rather than being replaced by a
 * parameter: `report()` is called from deep inside a step's own helpers, and
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
 * `undefined` rather than throwing, and `report()` degrades to a log line. The
 * DevKit's `getStepMetadata()` threw here, which is why `workflow-report.ts`
 * carries a try/catch around it that this makes unnecessary.
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
      }
    | undefined;
  /** Append a progress chunk. Bound to this run by whoever entered the context. */
  write(namespace: string, value: unknown): Promise<number>;
};

/**
 * The one store for the process.
 *
 * Module-level, which is the only thing that works: two stores would each see
 * only their own `run()` calls, so a `report()` reaching the wrong one would
 * silently find no context and degrade to log-only.
 */
const storage = new AsyncLocalStorage<RunContext>();

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
