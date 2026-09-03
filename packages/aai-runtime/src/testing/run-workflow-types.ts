// Copyright 2026 the AAI authors. MIT license.
/**
 * What {@link runWorkflow} takes and what it hands back.
 *
 * Split from `run-workflow.ts` at the seam `eval/workflow-engine-types.ts` and
 * `sdk/dialog-types.ts` are cut on: what a caller passes IN and reads back,
 * versus the driver that produces it.
 *
 * @module
 */

import type { WorkflowRunStatus } from "@alexkroman1/aai/workflow-api";
import type { Logger } from "../runtime-config.ts";
import type { JournalStore } from "../workflow-journal-types.ts";
import type { DeterminismKind } from "../workflow-replay-determinism.ts";

/**
 * One journaled determinism read — what `ctx.now()`, `ctx.random()` or
 * `ctx.uuid()` answered, and will answer again on every later walk.
 *
 * @public
 */
export type WorkflowTestRead = {
  /** `now!0`, `random!0`, `uuid!0` — the reserved key space, per kind. */
  readonly key: string;
  /** Which affordance this reach was. */
  readonly kind: DeterminismKind;
  /** The value the journal holds, which every replay reads back. */
  readonly value: unknown;
};

/**
 * One step the run journaled.
 *
 * A projection of the engine's own `StepEntry` rather than that type re-exported:
 * `finishedAt` is a wall clock, so a spec that could see it would be a spec that
 * could depend on it.
 *
 * @public
 */
export type WorkflowTestStep = {
  /** `name#occurrence` — what makes a step in a loop distinguishable. */
  readonly key: string;
  /** The name the body passed `ctx.step`. */
  readonly name: string;
  readonly status: "ok" | "failed";
  /** What the step returned. Present when `status` is `ok`. */
  readonly output?: unknown;
  /** Why it failed. Present when `status` is `failed`. */
  readonly error?: string | undefined;
  /**
   * Attempts this step consumed, counting the one that settled it.
   *
   * The field a spec asserting a RETRY reads: a `maxAttempts` step whose body
   * threw once and then succeeded settles at `2`.
   */
  readonly attempts: number;
};

/**
 * The run, as it stands after the last thing the driver did.
 *
 * @typeParam R - What the body returns, taken from the declaration.
 *
 * @public
 */
export type WorkflowTestRun<R> = {
  readonly runId: string;
  /**
   * Where the run is.
   *
   * `running` is the PARKED state as well as the executing one — a durable run
   * that suspended is in progress, it is just not executing — so a spec that
   * expects a wait asserts `running` plus a {@link WorkflowTestRun.wakeAt} or a
   * pending hook.
   */
  readonly status: WorkflowRunStatus;
  /** The body's return value, once the run is `completed`. */
  readonly output: R | undefined;
  /** The failure message, once the run is `failed`. */
  readonly error: string | undefined;
  /**
   * Every settled `ctx.step`, ordered by NAME and then by occurrence.
   *
   * ## Not the journal's order, deliberately
   *
   * `JournalStore.readSteps` answers by `finishedAt` with the key breaking a
   * tie, which is the right contract for a STORE — it is what makes three
   * backends comparable — and the wrong one to hand a spec. Two steps of one
   * fast walk settle inside the same millisecond routinely, so under that order
   * the obvious assertion
   * (`expect(run.steps.map((s) => s.key)).toEqual([…])`) passes on a slow
   * machine and fails on a quick one. That is a flake whose failure names a
   * timing detail rather than a bug, which is the shape this repo refuses
   * everywhere else it observes a clock.
   *
   * So the order here is a property of the BODY rather than of the run: `name`
   * ascending, then occurrence NUMERICALLY — `poll#2` before `poll#10`, which a
   * plain string sort gets wrong. Nothing is lost, because settle order under a
   * fan-out is the scheduler's and was never assertable anyway.
   *
   * `ctx.now()`, `ctx.random()` and `ctx.uuid()` are NOT in here — see
   * {@link WorkflowTestRun.reads}.
   */
  readonly steps: readonly WorkflowTestStep[];
  /**
   * Every journaled determinism read — `ctx.now()`, `ctx.random()`,
   * `ctx.uuid()` — in the same canonical order.
   *
   * Kept apart from {@link WorkflowTestRun.steps} because the ENGINE keeps them
   * apart: they are journaled through the same `appendStep` (which is what makes
   * a second walk read the same value, and what let them ship without a new
   * `JournalStore` method) but into a reserved key space of their own —
   * `now!0`, not `now#0` — and `isDeterminismKey` is the engine's own predicate
   * for the difference. They also carry no attempt, having no body to abandon.
   *
   * Folding them in was this surface's own bug: a spec asserting which call
   * sites a body reached got a `now` it never wrote, and the projection was
   * flattening a distinction the journal makes on purpose.
   */
  readonly reads: readonly WorkflowTestRead[];
  /**
   * The deadline the run is parked on, when it is parked on one.
   *
   * Read off what the body's suspension handed the dispatcher, which is the
   * journaled wake time — so a spec asserting "it slept for a day" compares this
   * against the instant the run started rather than waiting one.
   */
  readonly wakeAt: number | undefined;
  /**
   * Deliveries this run has taken.
   *
   * A durable run is delivered once per suspension plus once to start, so this
   * is what a spec reads to assert that a resume really was a SECOND walk rather
   * than one body that happened to keep going.
   */
  readonly deliveries: number;
  /** True once a {@link RunWorkflowOptions.crashAt} delivery was killed. */
  readonly crashed: boolean;
};

/**
 * A started run, plus the four things a spec can do to it.
 *
 * Every method drives the run and resolves the SAME handle, so a spec reads the
 * fields off it afterwards rather than threading a new value:
 *
 * ```ts
 * import { workflow } from "@alexkroman1/aai";
 * import { runWorkflow } from "@alexkroman1/aai-runtime/testing";
 *
 * const review = workflow({
 *   description: "Hold a draft until a human approves it.",
 *   run: async (_input, ctx) => await ctx.waitFor<{ approved: boolean }>("approval"),
 * });
 *
 * const run = await runWorkflow(review, {}, { name: "review" });
 * await run.signal("approval", { approved: true });
 * console.log(run.status, run.output);
 * ```
 *
 * @public
 */
export type WorkflowTestHandle<R> = WorkflowTestRun<R> & {
  /**
   * Cut short every wait the run is parked on, and deliver.
   *
   * `ctx.workflows.wakeUp`'s own mechanism, which is what makes it honest: the
   * journaled deadline is marked woken and the body continues from the journal,
   * exactly as it would when a tool decides not to wait out a schedule. It does
   * NOT move a clock, so a body that computes a duration from `ctx.now` still
   * sees the instant it was journaled with.
   *
   * A bare call reaches SLEEPS only. A hook's deadline is a different kind of
   * wait and is ended by naming its correlation id, or by answering it with
   * {@link WorkflowTestHandle.signal} — see `SleepRecord.kind` for the approval
   * window a bare wake used to close.
   *
   * Resolves this handle. Read `wakeAt` before calling it to assert what the
   * body asked for.
   */
  advanceSleep(correlationIds?: readonly string[]): Promise<WorkflowTestHandle<R>>;
  /**
   * Answer a `ctx.waitFor` token, and deliver.
   *
   * Resolves this handle. {@link WorkflowTestHandle.signalled} says whether
   * anything was holding the token — `false` for a token nobody waits on, one
   * already answered, or one whose window has closed, which are the same refusal
   * a deployed `ctx.workflows.signal` gives.
   */
  signal(token: string, payload?: unknown): Promise<WorkflowTestHandle<R>>;
  /** What the last {@link WorkflowTestHandle.signal} answered. */
  readonly signalled: boolean;
  /**
   * Close every `ctx.waitFor` WINDOW the run is parked on, and deliver.
   *
   * The branch a body's safe default lives in, and the one nothing else can
   * reach. A `waitFor(token, { timeoutMs })` journals its deadline as a sleep of
   * kind `hookTimeout`, and `ctx.workflows.wakeUp` deliberately cannot end one:
   * a bare wake is the "send it now" call a tool makes to cut a SCHEDULE short,
   * and letting it also close an approval window would cancel something the body
   * never asked to cancel. A targeted wake cannot either — the deadline carries
   * no correlation id. So without this, the only way to reach the timeout branch
   * is to wait out a window measured in minutes.
   *
   * It does NOT move a clock and does not rewrite the stored record. It answers
   * the deadline READ the way an elapsed one answers it — `woken`, which
   * `SleepRecord` defines as "a woken sleep returns immediately" — for the
   * duration of the delivery it triggers. Everything downstream is the engine's
   * own: the close is still a compare-and-set on `delivered`, so a payload that
   * landed first still wins and the body still takes the ANSWERED branch.
   *
   * Resolves this handle. A run parked on a `ctx.sleep` is unaffected;
   * {@link WorkflowTestHandle.advanceSleep} is that one.
   */
  expireWaits(): Promise<WorkflowTestHandle<R>>;
  /**
   * Throw this engine away, build a new one over the same journal, and deliver.
   *
   * The crash model an author cares about: the process is gone and the journal
   * is not. A step already journaled returns its stored result without running,
   * and a step that was mid-flight runs again — which is the at-least-once
   * contract seen from a body's own side.
   *
   * It models the redelivery a QUEUE makes rather than
   * `createInProcessWorkflowEngine`'s boot sweep, because this driver owns the
   * schedule (see {@link runWorkflow}). The sweep — the thing that re-enqueues a
   * run whose deadline outlived the process — has its own property in this
   * package and is not what a template spec is asserting.
   */
  restart(): Promise<WorkflowTestHandle<R>>;
  /**
   * The journal the run lives in, for an assertion this handle does not cover.
   *
   * The same store a caller may pass in as {@link RunWorkflowOptions.journal},
   * so a spec can start a second run against the same world.
   */
  readonly journal: JournalStore;
  /**
   * Stop the engine.
   *
   * Nothing leaks without it — this driver injects its own dispatcher, so no
   * timer is ever armed — but a run left open is still an engine holding a
   * journal, and calling it is what keeps that true if the driver ever arms one.
   */
  close(): Promise<void>;
};

/**
 * What {@link runWorkflow} takes.
 *
 * @public
 */
export type RunWorkflowOptions = {
  /**
   * The name the workflow is registered under, as `agent({ workflows })` keys
   * it. Defaults to `"workflow"`.
   *
   * It is what the body reads as `ctx.workflow`, and what a run's record
   * carries — so a spec asserting on either passes the real key.
   */
  name?: string;
  /**
   * The store the run lives in. Defaults to a fresh in-memory journal.
   *
   * Pass one to start two runs in the same world, or to inspect the journal a
   * previous run left behind.
   */
  journal?: JournalStore;
  /** Where the engine logs. Defaults to silence. */
  logger?: Logger;
  /**
   * Kill the first delivery that reaches this step, before its body runs.
   *
   * A worker that died mid-run, which is the one durable-execution failure a
   * body cannot be written against without being able to produce it. It fires
   * ONCE and then disarms, so {@link WorkflowTestHandle.restart} resumes rather
   * than crashing again.
   *
   * The kill lands after the step's attempt has been CHARGED and before its body
   * runs, which is exactly where a real death lands — the charge is what a
   * resume reads to tell an abandoned attempt from one that never started.
   */
  crashAt?: string;
  /**
   * How many deliveries the driver may make before it gives up.
   *
   * A bound rather than a timeout: a body that suspends and is woken in a loop
   * would otherwise spin, and a spec that hangs reports the runner's timeout
   * instead of the loop. Defaults to {@link DEFAULT_MAX_DELIVERIES}.
   */
  maxDeliveries?: number;
};
