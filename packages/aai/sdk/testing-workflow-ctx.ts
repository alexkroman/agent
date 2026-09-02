// Copyright 2026 the AAI authors. MIT license.
/**
 * A {@link WorkflowCtx} for driving a workflow BODY from a spec.
 *
 * The body is the half of a workflow that nothing else can test. Its steps are
 * ordinary exported functions a spec calls directly, and its declaration is a
 * value a spec reads — but the body itself takes a `ctx` only an engine
 * constructs, so before this a spec could either not call it at all or hand-roll
 * the four-method object. Three templates hand-rolled it, which is this repo's
 * threshold for extracting.
 *
 * ## It RUNS the steps, and records them
 *
 * A pass-through by default: `ctx.step(name, fn)` calls `fn` and returns what it
 * returns, while recording the name and the options. So a spec drives the real
 * body over the real steps, with the collaborators stubbed the way they already
 * are (`installStubGateway`, `stubTranscribe`, `stubStepFetch`), and can then
 * assert both what happened and what the body ASKED FOR — a step's retry policy
 * being an argument now rather than a property, `{ maxAttempts }` is only
 * observable at the call.
 *
 * `runSteps: false` records without executing, for a spec whose subject is the
 * policy or the ORDER rather than the work.
 *
 * ## What it deliberately does NOT do
 *
 * **It is not a durability test, and a spec built on it must not claim to be
 * one.** There is no journal, so nothing is memoized and nothing replays; a
 * `ctx.sleep` is RECORDED rather than taken, so a body's schedule is assertable
 * without waiting a day; and `ctx.waitFor` answers from `hooks` or throws,
 * because a hook's payload comes from outside the run and inventing one would
 * evaluate a run nobody could have produced. Replay, resume and retry belong to
 * the engine's own specs and to the scenario tier.
 *
 * That is the same set of limits `@alexkroman1/aai-runtime/eval`'s workflow
 * engine has, stated the same way — the difference being that this needs no
 * engine at all, so it is what a TEMPLATE reaches for.
 *
 * @module testing-workflow-ctx
 */

import type { SleepOptions, StepOptions, WaitForOptions, WorkflowCtx } from "./workflow-ctx.ts";

/** One step the body reached, as the recorder saw it. */
export type RecordedStep = {
  name: string;
  /** What the body asked for, or `undefined` when it passed no options. */
  maxAttempts?: number | undefined;
};

/** One wait the body asked for — and did NOT take. */
export type RecordedSleep = {
  /** Exactly what the body passed: milliseconds, or a `Date`. */
  until: number | Date;
  correlationId?: string | undefined;
};

/** What {@link createWorkflowCtx} answers: a real `WorkflowCtx` plus its log. */
export type WorkflowCtxRecorder = WorkflowCtx & {
  /** Every step reached, in the order the body reached them. */
  readonly steps: RecordedStep[];
  /** Every `ctx.sleep`, in order. */
  readonly slept: RecordedSleep[];
  /** Every token `ctx.waitFor` was called with, in order. */
  readonly waited: string[];
};

/** What {@link createWorkflowCtx} takes. */
export type WorkflowCtxOptions = {
  /** Defaults to `"wrun_test"`. */
  runId?: string;
  /** The declared key. Defaults to `"test"`. */
  workflow?: string;
  /**
   * Run each step's `fn`, or only record that it was reached.
   *
   * Defaults to `true`, which is what makes this drive a REAL body. Pass `false`
   * when the subject is the policy or the order — a step that is not run needs
   * no collaborator stubbed, so such a spec stays short.
   *
   * Note a recorded-only step resolves `undefined`, so a body that reads its
   * result will see one. That is the honest cost of not running it.
   */
  runSteps?: boolean;
  /**
   * Results to answer particular steps with, by step NAME.
   *
   * Takes precedence over running the step, so it works in both modes: with
   * `runSteps: true` it stubs one expensive step and leaves the rest real, and
   * with `runSteps: false` it is what makes a body whose control flow READS its
   * steps drivable at all — `planAngles` returning `undefined` otherwise reaches
   * the fan-out below it as a missing list.
   *
   * Keyed by name rather than by occurrence: a step in a loop is one name, and a
   * spec that needs the iterations to differ wants `runSteps: true` with the
   * collaborator stubbed instead.
   */
  results?: Record<string, unknown>;
  /**
   * Payloads for `ctx.waitFor`, by token.
   *
   * A token that is absent THROWS rather than hanging, because a spec that hangs
   * reports a timeout naming the runner instead of the missing payload.
   */
  hooks?: Record<string, unknown>;
};

/**
 * Build a `WorkflowCtx` that runs a body and records what it asked for.
 *
 * @example
 * ```ts no-check
 * const ctx = createWorkflowCtx();
 * const output = await digestFlow({ url: "https://example.com/a" }, ctx);
 *
 * expect(output.headline).toBe("…");
 * expect(ctx.steps.map((s) => s.name)).toEqual(["fetchArticle", "summarize", "file"]);
 * expect(ctx.slept).toEqual([{ until: 10_000 }]);
 * ```
 *
 * @public
 */
export function createWorkflowCtx(options: WorkflowCtxOptions = {}): WorkflowCtxRecorder {
  const steps: RecordedStep[] = [];
  const slept: RecordedSleep[] = [];
  const waited: string[] = [];
  const runSteps = options.runSteps ?? true;
  const hooks = options.hooks ?? {};
  const results = options.results ?? {};

  return {
    runId: options.runId ?? "wrun_test",
    workflow: options.workflow ?? "test",
    steps,
    slept,
    waited,

    async step<T>(name: string, fn: () => Promise<T> | T, stepOptions?: StepOptions): Promise<T> {
      steps.push({ name, maxAttempts: stepOptions?.maxAttempts });
      // A supplied result wins over running, in either mode — see `results`.
      // `Object.hasOwn`, never `in`: `in` walks the prototype chain, so a step
      // named `toString` or `constructor` would be answered with an inherited
      // `Object.prototype` method instead of being run.
      if (Object.hasOwn(results, name)) return results[name] as T;
      // The cast is the honest shape of `runSteps: false`: the caller has said it
      // does not want the work done and named no result, so there is no `T` to
      // answer with. A body that reads it sees `undefined`, which is what that
      // combination costs — pass a `results` entry when the body needs a value.
      if (!runSteps) return undefined as T;
      return fn();
    },

    async sleep(until: number | Date, sleepOptions?: SleepOptions): Promise<void> {
      slept.push({ until, correlationId: sleepOptions?.correlationId });
    },

    async waitFor<T>(token: string, waitOptions?: WaitForOptions): Promise<T | undefined> {
      waited.push(token);
      // `Object.hasOwn` for the reason `step` gives: `in` would answer a token
      // named after an `Object.prototype` member with an inherited function.
      if (Object.hasOwn(hooks, token)) return hooks[token] as T;
      // A wait with a DEADLINE resolves `undefined` when nobody answered, which
      // is the branch a body written for a closing window takes — so a spec
      // reaches that branch by simply not supplying a payload.
      if (waitOptions !== undefined) return undefined;
      // Without one there is no honest answer, and hanging would report a
      // runner timeout instead of the missing payload.
      throw new Error(
        `createWorkflowCtx: no payload for hook ${JSON.stringify(token)}. ` +
          `Pass one as { hooks: { ${JSON.stringify(token)}: … } }, or give the wait a ` +
          "timeoutMs so the unanswered branch is what runs.",
      );
    },
  };
}
