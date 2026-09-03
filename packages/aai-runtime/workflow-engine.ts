// Copyright 2026 the AAI authors. MIT license.
/**
 * The engine as the run API already expects it: a {@link WdkAdapter} over a
 * journal, a stream store and a dispatcher.
 *
 * This is the module that made the Workflow DevKit removable. Everything above
 * the nine-method adapter interface — `workflow-client.ts`, the fifteen
 * `workflow-api-*.ts` route modules, the run notifier — was already written
 * against that interface rather than against the DevKit, so replacing the
 * implementation was a one-line change in `workflow-runtime.ts`. The seam is
 * still named `Wdk*` for the thing it replaced; see `workflow-wdk-types.ts`.
 *
 * ## Starting a run and RUNNING one are deliberately separate
 *
 * {@link WorkflowEngine.start} creates the record and hands the run to a
 * dispatcher; it does not execute anything. {@link WorkflowEngine.execute} is
 * what a delivery calls. Keeping them apart is what lets the same engine serve
 * all three deployments without knowing which it is in:
 *
 * - **`aai dev`, host mode, a self-hosted server** — the dispatcher runs the run
 *   in this process, on the next turn of the loop.
 * - **A deployed guest** — the dispatcher POSTs the platform's queue, which
 *   delivers to `/workflow-queue`, which calls `execute`.
 *
 * A `start` that executed inline would make the first case the only one, and it
 * is the case that does not need to be durable.
 *
 * ## A delivery is AT-LEAST-ONCE, and `execute` is written for that
 *
 * Two deliveries of one run may overlap. What keeps that safe is not a lock — a
 * lock is a thing to lose — but the journal: a step already settled is answered
 * from it, and `appendStep` is idempotent on its key, so the loser of a race
 * adopts the winner's value. The one thing a lock WOULD buy is not doing the work
 * twice, which is a cost rather than a correctness problem, so the status
 * compare-and-set below is the only mutual exclusion here.
 */

import type { WorkflowDef } from "@alexkroman1/aai";
import { isRecord, omitUndefined } from "@alexkroman1/aai/utils";
import type { Logger } from "./runtime-config.ts";
import { guestCodeVersion } from "./workflow-code-version.ts";
import { isTerminalStatus, type JournalStore, type RunRecord } from "./workflow-journal-types.ts";
import { type ReplayOptions, type ReplayOutcome, replayRun } from "./workflow-replay.ts";
import { createStepGate, resolveStepConcurrency, type StepGate } from "./workflow-step-gate.ts";
import { type StreamStore, streamNamespace } from "./workflow-streams.ts";
import type { WdkAdapter, WdkRunRecord, WdkStreamOptions } from "./workflow-wdk-types.ts";

/** What one engine needs. */
export type WorkflowEngineOptions = {
  /** The agent's declared workflows, keyed by the name they are declared under. */
  workflows: Readonly<Record<string, WorkflowDef>>;
  journal: JournalStore;
  streams: StreamStore;
  /**
   * Hand a run to whatever will execute it, now or at `at`.
   *
   * May resolve a promise, and a REJECTION means the run was not scheduled. Only
   * one caller awaits it and the split is the point: `execute` does, because its
   * own resolution is what acks a delivery — a re-enqueue that failed silently
   * left a run with a journal row, no queue message, and a platform wake sweep
   * that reads the queue, so nothing would ever boot a guest for it again.
   * `start`, `wakeUp` and `signal` do not: a caller of `ctx.workflows.start` is
   * told the run's id and nothing about its progress, so awaiting there would let
   * a slow queue block a tool call and failing there would give `start` a second
   * failure mode with no better answer than the retry the queue already owns.
   *
   * A dispatcher that cannot fail (the in-process one) still returns nothing,
   * which is why the type is a union rather than `Promise<void>`.
   *
   * `at` is a wall-clock millisecond deadline, set when a body SUSPENDED on
   * `ctx.sleep`. A dispatcher that cannot delay may deliver immediately: the
   * body re-suspends on the same journaled wake time, so the wait is still
   * honoured — it just costs a wasted delivery, which is the right way for a
   * limited dispatcher to be wrong.
   */
  dispatch: (runId: string, at?: number) => void | Promise<void>;
  /** Mints a run id. Injected so a spec can pin one. */
  newRunId: () => string;
  /**
   * How many step bodies may EXECUTE at once in this process.
   *
   * Defaults to `resolveStepConcurrency()`, which reads
   * `AAI_WORKFLOW_STEP_CONCURRENCY` and falls back to
   * `DEFAULT_STEP_CONCURRENCY` — measured against a guest rather than inherited
   * from the world this replaced. A spec passes its own; nothing should pass
   * `Infinity`, which is the state that killed a guest — see
   * `workflow-step-gate.ts`.
   */
  stepConcurrency?: number | undefined;
  logger: Logger;
};

/** The engine, which is an adapter plus the door a delivery comes through. */
export type WorkflowEngine = WdkAdapter & {
  /**
   * Execute one run to a terminal status.
   *
   * Idempotent in the sense that matters: calling it on a run that is already
   * terminal is a no-op, and calling it on a partially-executed run resumes from
   * the journal. Resolves the status the run ended on, or `undefined` when there
   * was no such run.
   */
  execute(runId: string, signal?: AbortSignal): Promise<RunRecord["status"] | undefined>;
};

/** A journal record as the run API reads it. */
function toWdkRecord(record: RunRecord): WdkRunRecord {
  return {
    runId: record.runId,
    // The DECLARED key. Under the DevKit this field carried a compiler-minted
    // id and every reader translated; there is one identity now, and the field
    // keeps its name only because `WdkRunRecord` is the run API's shape.
    workflowName: record.workflow,
    status: record.status,
    createdAt: record.createdAt,
    // Both payload fields ride the record, and both are gated on the status
    // that gives them meaning: a snapshot reads them from here rather than
    // paying a second journal read for a value this one already carries.
    ...(record.status === "completed" ? { output: record.output } : {}),
    ...(record.status === "failed" && record.error ? { error: record.error } : {}),
  };
}

/**
 * Build the engine.
 *
 * @internal
 */
export function createWorkflowEngine(options: WorkflowEngineOptions): WorkflowEngine {
  const { workflows, journal, streams, dispatch, newRunId, logger } = options;
  // One gate for the ENGINE, not one per run: what it protects is process
  // memory, and a deployed guest serves every run of its slug.
  const gate: StepGate = createStepGate(options.stepConcurrency ?? resolveStepConcurrency());

  /**
   * The abort controller of every walk in flight, by run — what `cancel` stops.
   *
   * A SET per run rather than one controller each, because a delivery is
   * at-least-once and two walks of one run may overlap (see this module's doc).
   * A cancel has to reach both, and the loser of that race removing "the"
   * controller on its way out would leave the winner unstoppable.
   */
  const inFlight = new Map<string, Set<AbortController>>();

  /**
   * Hand a run to the dispatcher without waiting for it to be accepted.
   *
   * The three callers whose own answer is not an ack — see
   * {@link WorkflowEngineOptions.dispatch} for why each is deliberately not
   * fallible. `execute` is the one that awaits. No deadline, because all three
   * mean NOW: a `start` has a body to walk, and a wake or a signal has an answer
   * the body is waiting to read.
   *
   * The rejection is dropped rather than logged HERE, and that is not a swallow:
   * a dispatcher that can fail owns its own report — `createPlatformDispatch`
   * logs the run id at `error` before rejecting, and the in-process one cannot
   * fail at all. What the catch buys is that an unhandled rejection, which by
   * default ends the process, cannot come out of a tool's `start`.
   */
  function dispatchDetached(runId: string): void {
    void Promise.resolve(dispatch(runId)).catch(() => undefined);
  }

  /**
   * Fail a run for a reason the ENGINE found before the body ran.
   *
   * Two callers, both "this delivery can never succeed": the workflow is no
   * longer declared, and the stored input is not a record. Sharing them is not
   * about the three lines — it is that both must WRITE the failure rather than
   * leaving the run `pending` forever, which is the silent version of the same
   * outcome, and a second copy is the one that would forget the log line.
   */
  async function abandon(runId: string, workflow: string, message: string): Promise<"failed"> {
    await journal.setStatus(runId, "failed", { error: { message } });
    logger.warn?.("Workflow run abandoned", { runId, workflow, reason: message });
    return "failed";
  }

  /**
   * Record what one delivery's replay resolved to.
   *
   * Split from `execute` because the two answer different questions — `execute`
   * decides whether this delivery may run the body at all, and this decides what
   * the run becomes afterwards. Keeping them together put both in one function
   * Biome measured at complexity 20.
   */
  async function recordOutcome(
    runId: string,
    outcome: ReplayOutcome,
  ): Promise<RunRecord["status"] | undefined> {
    if (outcome.kind === "suspended") {
      // The run stays `running` — it IS in progress, just not executing. A
      // cancel that landed while the body was in flight must not be
      // re-dispatched, so the status is re-read rather than assumed: this is the
      // one arm that does not write it.
      const current = (await journal.getRun(runId))?.status;
      // A timer schedules its own next delivery; a HOOK does not, and that is
      // the point of the undefined. Nothing but a signal ends a hook wait, so
      // dispatching anyway would poll a run that may be parked for a week — and
      // `signal` re-delivers it when the answer arrives.
      //
      // AWAITED, unlike every other dispatch in this module: `execute`'s
      // resolution is what acks the delivery this suspend came in on, so a
      // re-enqueue that failed has to fail the delivery too. Otherwise the
      // platform is told to forget a message whose replacement was never
      // accepted, and the run is scheduled by nothing — the platform's wake sweep
      // reads the QUEUE. Failing it instead retries the ORIGINAL message.
      if (current === "running" && outcome.wakeAt !== undefined) {
        await dispatch(runId, outcome.wakeAt);
      }
      return current;
    }

    // `expect` excludes the terminal statuses, which is what stops a run
    // CANCELLED mid-flight from being overwritten as completed by the worker
    // that had not noticed. The body ran to the end either way; what the cancel
    // decided is what the run is recorded as.
    const moved =
      outcome.kind === "completed"
        ? await journal.setStatus(runId, "completed", { output: outcome.output }, ["running"])
        : await journal.setStatus(runId, "failed", { error: outcome.error }, ["running"]);
    if (!moved) return (await journal.getRun(runId))?.status;
    return outcome.kind;
  }

  /**
   * Walk one delivery's body, under a signal `cancel` can abort.
   *
   * Split from `execute` for the reason `recordOutcome` was: the two answer
   * different questions — `execute` decides whether this delivery may run the
   * body at all, and this owns the WALK, which now has a lifetime (a controller
   * registered while it runs) as well as an outcome. Together Biome measured
   * them at complexity 22.
   */
  async function runWalk(
    runId: string,
    walk: Pick<ReplayOptions, "workflow" | "input" | "run" | "steps" | "startedUnder">,
    callerSignal: AbortSignal | undefined,
  ): Promise<RunRecord["status"] | undefined> {
    // One controller per WALK, registered before the body can run, so `cancel`
    // has something to abort. A caller's own signal is COMBINED rather than
    // replaced, and the two stay distinguishable below: an abort this engine
    // raised is the run's own answer, an abort the caller raised is theirs.
    const controller = new AbortController();
    const walking = inFlight.get(runId) ?? new Set<AbortController>();
    walking.add(controller);
    inFlight.set(runId, walking);
    try {
      return await recordOutcome(
        runId,
        await replayRun({
          ...walk,
          runId,
          journal,
          streams,
          signal: callerSignal
            ? AbortSignal.any([callerSignal, controller.signal])
            : controller.signal,
          gate,
          logger,
        }),
      );
    } catch (err: unknown) {
      // Not ours: a caller-supplied signal, or a real failure of the journal.
      if (!(controller.signal.aborted && err === controller.signal.reason)) throw err;
      // `cancel` stopped this walk, and the status it wrote is the answer. A
      // rejection here would have the delivery answer 500 for a run somebody
      // deliberately stopped, and the queue would retry it until the abandonment
      // budget ran out — reporting a cancel as an outage.
      return (await journal.getRun(runId))?.status;
    } finally {
      walking.delete(controller);
      // Only once the LAST walk of this run is out: an entry left behind is a
      // leak, and one removed early leaves a concurrent walk unstoppable.
      if (walking.size === 0) inFlight.delete(runId);
    }
  }

  return {
    async start(workflow: string, args: unknown[]): Promise<string> {
      // `args` is the adapter's shape — the DevKit's `start` was variadic. A
      // body takes exactly one input, so the first element IS the input and a
      // second would be silently dropped; this refuses instead, because the one
      // caller is `workflow-client.ts` and a second element means it changed.
      if (args.length !== 1) {
        throw new Error(`workflow ${workflow} takes one input, got ${args.length} argument(s)`);
      }
      if (!workflows[workflow]) {
        throw new Error(`no workflow declared as ${JSON.stringify(workflow)}`);
      }
      const runId = newRunId();
      await journal.createRun({
        runId,
        workflow,
        status: "pending",
        createdAt: Date.now(),
        input: args[0],
        // Which CODE this run is starting against, so a walk after a redeploy can
        // say so rather than making the divergence message guess. Read from THIS
        // process's environment — `workflow-code-version.ts` carries why a
        // forgeable version is worse than none.
        ...omitUndefined({ codeVersion: guestCodeVersion() }),
      });
      // After the record exists, never before: a dispatcher that delivered first
      // would race a worker against `createRun` and report "no such run" for a
      // run that is about to exist.
      dispatchDetached(runId);
      return runId;
    },

    async execute(runId: string, signal?: AbortSignal): Promise<RunRecord["status"] | undefined> {
      const record = await journal.getRun(runId);
      if (!record) return undefined;
      // A terminal run is DONE, and a redelivery of one is ordinary rather than
      // an error: the platform's queue acks on a 200, so any delivery whose ack
      // was lost arrives again after the run finished.
      if (isTerminalStatus(record.status)) return record.status;

      const def = workflows[record.workflow];
      // The agent no longer declares this workflow — a redeploy that renamed or
      // removed one, with a run still in flight. There is no body to replay.
      if (!def) {
        return abandon(runId, record.workflow, `workflow ${record.workflow} is no longer declared`);
      }

      // The input crossed a wire to get here, and a body's parameter is an object
      // because a workflow's schema is an object schema. So this is a genuine
      // boundary check rather than a cast in checked clothing: a non-record input
      // means the store gave back something no `start` could have written, and
      // replaying a body against it would fail somewhere deeper and less legibly.
      if (!isRecord(record.input)) {
        return abandon(
          runId,
          record.workflow,
          `workflow run ${runId} has a malformed input record`,
        );
      }

      // Started BESIDE the compare-and-set below rather than after it. The walk
      // opens with this read (`ReplayOptions.steps`) and nothing about it
      // depends on the status write, so issuing them together takes a delivery
      // from three sequential platform round trips to two — measured at ~840 ms
      // each on a deployed run. A rejection belongs to whoever awaits it; the
      // no-op catch is only so an early return below cannot leave one
      // unhandled.
      const steps = journal.readSteps(runId);
      void steps.catch(() => undefined);

      // Compare-and-set, so exactly one delivery announces the run as started.
      // An overlapping delivery still wins it — `running` is in `expect` — so the
      // only way to lose is a status this delivery may not run: the run went
      // TERMINAL between the read above and here, which is the window a cancel
      // arriving a moment before the walk lands in. The loser of the ordinary
      // race proceeds anyway; see this module's doc on why the journal and not a
      // lock is what makes that safe.
      if (!(await journal.setStatus(runId, "running", undefined, ["pending", "running"]))) {
        return (await journal.getRun(runId))?.status;
      }

      return runWalk(
        runId,
        {
          workflow: record.workflow,
          input: record.input,
          run: def.run,
          steps,
          // The version this run STARTED against, for the divergence message to
          // compare against this process's. Passed even when absent: the field
          // takes `undefined` and the comparison reads it as unknown.
          startedUnder: record.codeVersion,
        },
        signal,
      );
    },

    async getRun(runId: string): Promise<WdkRunRecord | undefined> {
      const record = await journal.getRun(runId);
      return record ? toWdkRecord(record) : undefined;
    },

    async listRuns(workflow: string, limit: number): Promise<WdkRunRecord[]> {
      return (await journal.listRuns(workflow, limit)).map(toWdkRecord);
    },

    async cancel(runId: string): Promise<boolean> {
      // "True when THIS call is what ended it" — the contract
      // `WorkflowClient.cancel` promises. The compare-and-set answers it
      // directly, which is the one place this engine is simpler than the adapter
      // it replaces: `workflow-wdk.ts` needed a speculative read plus two
      // error-class predicates plus a cause-chain walk to reach the same
      // boolean, because the DevKit signalled all three outcomes by throwing and
      // did so differently per world.
      const ended = await journal.setStatus(runId, "cancelled", undefined, ["pending", "running"]);
      // And STOP the body, which is the half `WorkflowClient.cancel`'s "Stop a
      // run" promises and a status write cannot keep on its own. `replayRun`
      // checks an `AbortSignal` before each step and no production caller ever
      // supplied one — `deliver()` calls `execute(runId)` bare, and so does
      // `BuiltWorkflowClient.execute` — so a cancelled run ran every remaining
      // step to completion and had only its final status write refused.
      //
      // Only when THIS call is what ended it: the call that did owns the abort,
      // and a `false` is a run that was already terminal or never existed.
      if (ended) for (const controller of inFlight.get(runId) ?? []) controller.abort();
      return ended;
    },

    async wakeUp(runId: string, correlationIds: string[] | undefined): Promise<number> {
      const stopped = await journal.wakeSleeps(runId, correlationIds);
      // Re-deliver so the woken body actually continues, rather than waiting out
      // the deadline it was told to skip. Only when something was stopped: a
      // `wake` on a run that is not waiting is an ordinary answer (0) and must
      // not cost a delivery.
      if (stopped > 0) dispatchDetached(runId);
      return stopped;
    },

    async signal(token: string, payload: unknown): Promise<boolean> {
      const runId = await journal.deliverHook(token, payload);
      // `false` is what "no hook holds this token" means, and it is the ORDINARY
      // answer rather than an error: a token whose run has moved past its wait,
      // finished, or was never started is indistinguishable to the caller, and a
      // caller that had to catch this would catch it on the happy path.
      if (!runId) return false;
      // The answer is stored; the body has to be re-walked to read it.
      dispatchDetached(runId);
      return true;
    },

    async streamTail(runId: string, streamOptions: WdkStreamOptions): Promise<number> {
      return streams.tail(runId, streamNamespace(streamOptions.namespace));
    },

    readStream(runId: string, streamOptions: WdkStreamOptions): ReadableStream<unknown> {
      // A snapshot of what is written, closed at the tail. That is a real
      // difference from the DevKit's stream, which stayed open, and it is the
      // better shape for the one thing the interface documents the tail for: a
      // progress channel is never closed by its writer, so a reader that waits
      // for the end waits forever. Bounding the read HERE means the caller's
      // `finally`-cancel is a formality rather than the only thing preventing a
      // leaked pump — the failure `workflow-wdk.ts`'s `streamTail` had to
      // measure and defend against.
      return new ReadableStream<unknown>({
        async start(controller) {
          try {
            for (const chunk of await streams.read(runId, streamOptions)) {
              controller.enqueue(chunk.value);
            }
            controller.close();
          } catch (err: unknown) {
            controller.error(err);
          }
        },
      });
    },

    async readOutput(runId: string): Promise<unknown> {
      const record = await journal.getRun(runId);
      // Only meaningful on a completed run, which is the caller's precondition
      // (`toSnapshot` reads it having observed `completed`). Answering
      // `undefined` for anything else rather than polling is the deliberate
      // difference from the DevKit, whose `returnValue` waited on a pending run
      // at 1s intervals with no ceiling — so a speculative read there turned a
      // snapshot into a wait for the whole run.
      return record?.status === "completed" ? record.output : undefined;
    },
  };
}
