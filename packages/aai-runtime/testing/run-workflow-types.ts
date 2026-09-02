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
  /** Every settled step, oldest first. */
  readonly steps: readonly WorkflowTestStep[];
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
