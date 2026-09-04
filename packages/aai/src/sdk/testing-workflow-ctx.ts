// Copyright 2026 the AAI authors. MIT license.
/**
 * A {@link WorkflowContext} for driving a workflow BODY from a spec.
 *
 * The body is the half of a workflow that nothing else can test. Its steps are
 * ordinary exported functions a spec calls directly, and its declaration is a
 * value a spec reads — but the body itself takes a `ctx` only an engine
 * constructs, so before this a spec could either not call it at all or hand-roll
 * every method on it. Three templates hand-rolled it, which is this repo's
 * threshold for extracting — and the count is the argument for keeping it here
 * rather than in each spec: it was four methods and is seven.
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
 * `ctx.now`, `ctx.random` and `ctx.uuid` are the same story from the other end:
 * against the real engine each is journaled, so the same value comes back on
 * every walk. There is one walk here, so there is nothing to memoize — what
 * matters instead is that the defaults are FIXED (see `now`, `random`, `uuid`
 * below), because a spec over a body that stamps a duration or mints an id is
 * unwritable against a live clock.
 *
 * That is the same set of limits `@alexkroman1/aai-runtime/eval`'s workflow
 * engine has, stated the same way — the difference being that this needs no
 * engine at all.
 *
 * ## What to reach for when durability IS the subject
 *
 * `runWorkflow` from `@alexkroman1/aai-runtime/testing`. It starts the declared
 * workflow on the real engine over a memory journal, so a spec can assert that
 * a run suspended, resumed off its journal without redoing settled work,
 * retried, was answered by a signal, and survived a worker that died mid-step.
 * It lives on the runtime because the engine does, and `@alexkroman1/aai`
 * imports no sibling package.
 *
 * The two are complements rather than alternatives, and the split is what each
 * makes cheap: this records what a body ASKED FOR — a step's `maxAttempts`, a
 * sleep's duration, the order — over one walk with no journal, so a spec about a
 * POLICY stays three lines. That one runs the body for real, so a spec about
 * DURABILITY is possible at all.
 *
 * @module testing-workflow-ctx
 */

import { formatSchemaIssues, type StandardSchemaV1 } from "./standard-schema.ts";
import type {
  SleepOptions,
  StepOptions,
  WaitForOptions,
  WaitForSchemaOptions,
  WorkflowContext,
} from "./workflow-ctx.ts";

/**
 * The value a `schema` option passed, or a throw naming what it rejected.
 *
 * The recorder journals nothing, so it cannot make the engine's WRITE/READ
 * distinction — but it can make the half a spec is written against: a fixture
 * that does not satisfy the schema the body declared is one a deployed run would
 * refuse, and a recorder that handed it over anyway would let a spec pass on a
 * value the real engine cannot produce. Which is the same argument the option
 * itself rests on, one layer up.
 *
 * `what` names the step or hook rather than the shape, because the issues carry
 * the shape and the reader needs to know which call produced them.
 */
async function checkedAgainst(
  what: string,
  value: unknown,
  schema: StandardSchemaV1 | undefined,
): Promise<unknown> {
  if (schema === undefined) return value;
  const result = await schema["~standard"].validate(value);
  if (result.issues) {
    throw new Error(
      `createWorkflowContext: ${what} does not match the schema it declared: ` +
        formatSchemaIssues(result.issues),
    );
  }
  return result.value;
}

/** One step the body reached, as the recorder saw it. */
export type RecordedStep = {
  name: string;
  /** What the body asked for, or `undefined` when it passed no options. */
  maxAttempts?: number | undefined;
};

/** One wait the body asked for — and did NOT take. */
export type RecordedSleep = {
  /**
   * The wait's `label` — its identity in a real run's journal, and the field a
   * case asserting a SCHEDULE actually wants: a body with two waits is telling
   * you WHICH one it reached, which a duration cannot.
   */
  label: string;
  /** Exactly what the body passed: milliseconds, or a `Date`. */
  until: number | Date;
  correlationId?: string | undefined;
};

/** What {@link createWorkflowContext} answers: a real `WorkflowContext` plus its log. */
export type WorkflowContextRecorder = WorkflowContext & {
  /** Every step reached, in the order the body reached them. */
  readonly steps: RecordedStep[];
  /** Every `ctx.sleep`, in order. */
  readonly slept: RecordedSleep[];
  /** Every token `ctx.waitFor` was called with, in order. */
  readonly waited: string[];
};

/** What {@link createWorkflowContext} takes. */
export type WorkflowContextOptions = {
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
  /**
   * What `ctx.now()` answers — a fixed number, or a function called per reach.
   *
   * Defaults to {@link WORKFLOW_CONTEXT_NOW}, a FIXED instant, so a body's derived
   * durations are constants a spec can write down. There is no journal here, so
   * nothing is memoized: a function is called once per reach, which is what a
   * spec asserting on two reads (a start and an end) wants.
   */
  now?: number | (() => number);
  /** What `ctx.random()` answers. Defaults to a fixed `0.5`. */
  random?: number | (() => number);
  /**
   * What `ctx.uuid()` answers.
   *
   * Defaults to a DISTINCT value per reach — `"uuid-0"`, `"uuid-1"`, … — because
   * a body that mints two ids and gets one is a body whose bug the spec would
   * hide. Not a real UUID, deliberately: a spec asserting on a shape rather than
   * on a value is asserting on the fake.
   */
  uuid?: string | (() => string);
};

/**
 * The instant {@link createWorkflowContext} freezes `ctx.now()` at.
 *
 * `2026-01-01T00:00:00.000Z`. Exported so a spec computes an expected duration
 * from it rather than copying the number.
 */
export const WORKFLOW_CONTEXT_NOW = 1_767_225_600_000;

/**
 * Build a `WorkflowContext` that runs a body and records what it asked for.
 *
 * @example
 * ```ts no-check
 * const ctx = createWorkflowContext();
 * const output = await digestFlow({ url: "https://example.com/a" }, ctx);
 *
 * expect(output.headline).toBe("…");
 * expect(ctx.steps.map((s) => s.name)).toEqual(["fetchArticle", "summarize", "file"]);
 * expect(ctx.slept).toEqual([{ label: "settle", until: 10_000 }]);
 * ```
 *
 * @public
 */
export function createWorkflowContext(
  options: WorkflowContextOptions = {},
): WorkflowContextRecorder {
  const steps: RecordedStep[] = [];
  const slept: RecordedSleep[] = [];
  const waited: string[] = [];
  const runSteps = options.runSteps ?? true;
  const hooks = options.hooks ?? {};
  const results = options.results ?? {};
  // `T extends number | string` is what lets `typeof given === "function"`
  // narrow with no cast: an unbounded `T` might itself be a function type, so
  // the check would say nothing about which arm this is.
  function answer<T extends number | string>(
    given: T | (() => T) | undefined,
    fallback: () => T,
  ): () => T {
    if (given === undefined) return fallback;
    if (typeof given === "function") return given;
    return () => given;
  }
  const nowOf = answer(options.now, () => WORKFLOW_CONTEXT_NOW);
  const randomOf = answer(options.random, () => 0.5);
  let minted = 0;
  const uuidOf = answer(options.uuid, () => `uuid-${minted++}`);

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
      const schema = stepOptions?.schema;
      if (Object.hasOwn(results, name)) {
        return (await checkedAgainst(`the result for step ${name}`, results[name], schema)) as T;
      }
      // The cast is the honest shape of `runSteps: false`: the caller has said it
      // does not want the work done and named no result, so there is no `T` to
      // answer with. A body that reads it sees `undefined`, which is what that
      // combination costs — pass a `results` entry when the body needs a value.
      //
      // Deliberately BEFORE the check below and never checked itself: there is no
      // value here to validate, and running the schema over the stand-in would
      // fail every step of a recorder configured not to run any.
      if (!runSteps) return undefined as T;
      return (await checkedAgainst(`the output of step ${name}`, await fn(), schema)) as T;
    },

    async sleep(label: string, until: number | Date, sleepOptions?: SleepOptions): Promise<void> {
      slept.push({ label, until, correlationId: sleepOptions?.correlationId });
    },

    // The three journaled reads, answered from the options above. NOT recorded
    // the way `steps`/`slept`/`waited` are, and the asymmetry is deliberate: a
    // step's name and a sleep's duration are invisible in what the body returns,
    // where a determinism read's value flows INTO the output — so the output is
    // already the assertion, and a second log of it would be a second thing to
    // keep in step with the first.
    async now(): Promise<number> {
      return nowOf();
    },

    async random(): Promise<number> {
      return randomOf();
    },

    async uuid(): Promise<string> {
      return uuidOf();
    },

    async waitFor<T>(
      token: string,
      // Both bags, because a wait may carry a schema with no deadline at all —
      // see `WaitForSchemaOptions`. `timeoutMs` is what tells them apart, and it
      // is the presence of a DEADLINE rather than of options that decides the
      // unanswered branch below.
      waitOptions?: WaitForOptions | WaitForSchemaOptions,
    ): Promise<T | undefined> {
      waited.push(token);
      // `Object.hasOwn` for the reason `step` gives: `in` would answer a token
      // named after an `Object.prototype` member with an inherited function.
      if (Object.hasOwn(hooks, token)) {
        const payload = hooks[token];
        return (await checkedAgainst(
          `the payload for hook ${token}`,
          payload,
          waitOptions?.schema,
        )) as T;
      }
      // A wait with a DEADLINE resolves `undefined` when nobody answered, which
      // is the branch a body written for a closing window takes — so a spec
      // reaches that branch by simply not supplying a payload.
      if (waitOptions !== undefined && "timeoutMs" in waitOptions) return undefined;
      // Without one there is no honest answer, and hanging would report a
      // runner timeout instead of the missing payload.
      throw new Error(
        `createWorkflowContext: no payload for hook ${JSON.stringify(token)}. ` +
          `Pass one as { hooks: { ${JSON.stringify(token)}: … } }, or give the wait a ` +
          "timeoutMs so the unanswered branch is what runs.",
      );
    },
  };
}
