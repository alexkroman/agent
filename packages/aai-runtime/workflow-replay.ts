// Copyright 2026 the AAI authors. MIT license.
/**
 * The replay executor: run a workflow body against a journal, once.
 *
 * This is what replaced the Workflow DevKit's durable-execution engine, and it
 * is deliberately the smallest thing that is still correct. One function runs a
 * body; a body's `ctx.step` either answers from the journal or executes and
 * appends. There is no event log, no scheduler and no bundle transform, because
 * the identity problem those existed to solve — "which call is this?" — is
 * answered here by `(name, occurrence)` instead of by a compiler.
 *
 * ## The contract with the caller
 *
 * {@link replayRun} is called once per DELIVERY of a run message, and it is safe
 * to call again for the same run: every completed step is answered from the
 * journal rather than re-executed, so a redelivery costs a walk of the body and
 * whatever work is genuinely left. That is the whole durability story — there is
 * no separate recovery path to get wrong, because resume and first-run are the
 * same code.
 *
 * ## A failed step throws INTO the body
 *
 * This is the DevKit's semantics and it is worth keeping deliberately: a step
 * that exhausts its attempts throws, and the body may catch it. A workflow that
 * wants a fallback writes `try { await ctx.step(…) } catch { … }` and gets one.
 * So the run fails only when nothing catches, which is the ordinary way an
 * exception behaves and the reason an author does not need a second vocabulary
 * for "this step is allowed to fail".
 *
 * The consequence is that a failed step is JOURNALED, and its replay must throw
 * the same way — otherwise a body that caught a failure on the first execution
 * would take the success path on the second and diverge. {@link stepFailure}
 * reconstructs it.
 *
 * ## An unreached key while the journal still holds work is DIVERGENCE
 *
 * A body-level non-determinism that reaches a step NAME mints a journal key the
 * run has never seen, and an unseen key used to mean "run it" — measured at
 * **7 of 10 runs executing the side effect twice, all 10 reporting `completed`**.
 * `workflow-replay-divergence.ts` owns the check, the reproduction and the two
 * facts that decide it; `onFirstReach` in `workflow-replay-step.ts` is the half
 * that reads `claimAttempt`. What is here is only the wiring and the OUTCOME: a
 * refusal fails the run, and it does so even when the body swallows the throw.
 *
 * ## Suspension is a THROW
 *
 * A body that must wait — `ctx.sleep`, `ctx.waitFor` — cannot return, because the
 * wait may be days long and the process must be free meanwhile. So it throws
 * {@link SuspendSignal}, which unwinds whatever depth the call was made at and
 * which `replayRun` reports as an outcome rather than a failure. That is also the
 * whole reason a deadline is a PARAMETER of `waitFor` rather than a `Promise.race`
 * against `sleep`: a race stops the body on whichever suspends first, before the
 * other has been reached.
 */

import {
  DEFAULT_STEP_MAX_ATTEMPTS,
  isWorkflowSuspend,
  type SleepOptions,
  type StepOptions,
  type WaitForOptions,
  type WorkflowCtx,
} from "@alexkroman1/aai";
import { WORKFLOW_SUSPEND_BRAND } from "@alexkroman1/aai/internal";
import { errorMessage } from "@alexkroman1/aai/utils";
import type { JournalStore, StepEntry } from "./workflow-journal-types.ts";
import { createDeterminismReads } from "./workflow-replay-determinism.ts";
import { watchDivergence } from "./workflow-replay-divergence.ts";
import { runStepAttempts, stepFailure } from "./workflow-replay-step.ts";
import { waitInsideStep } from "./workflow-replay-wait.ts";
import { withRunContext } from "./workflow-run-context.ts";
import type { StepGate } from "./workflow-step-gate.ts";
import { type StreamStore, streamNamespace } from "./workflow-streams.ts";

/** What a run's execution resolved to. */
export type ReplayOutcome =
  | { kind: "completed"; output: unknown }
  | { kind: "failed"; error: { message: string } }
  /**
   * The body is waiting. Not an outcome the RUN has — it is still `running` —
   * but the outcome this DELIVERY has: the caller returns the worker.
   *
   * `wakeAt` present means a TIMER — schedule the next delivery for then.
   * `undefined` means a HOOK: there is no deadline, and the next delivery comes
   * from whoever signals. Scheduling one anyway would poll a run that may be
   * parked for a week.
   */
  | { kind: "suspended"; wakeAt: number | undefined };

/**
 * A body reaching a wait that has not elapsed.
 *
 * A throw rather than a returned sentinel, because a suspend has to unwind an
 * arbitrarily deep call stack — `ctx.sleep` may be reached from inside a helper
 * the body called — and there is no way to signal "stop and come back later" up
 * through code that is not expecting it.
 *
 * **JavaScript `catch` catches everything, so a body CAN swallow this**, and one
 * shipped template did: `recap-workflow`'s saga wrapped its whole body in a
 * `try`/`catch` that unwound the compensation stack, so the first poll that had
 * to wait deleted the transcript the run was waiting for. `isWorkflowSuspend`
 * (`@alexkroman1/aai`) is what a body's `catch` tests, and {@link replayRun}'s
 * own check below is what catches a body that forgot — see `sdk/workflow-suspend.ts`.
 *
 * Branded rather than merely named, so the predicate works across however many
 * copies of either module a guest bundle holds.
 */
class SuspendSignal extends Error {
  /** `undefined` for a hook — see `ReplayOutcome`. */
  readonly wakeAt: number | undefined;

  constructor(wakeAt: number | undefined) {
    super("workflow suspended");
    this.name = "SuspendSignal";
    this.wakeAt = wakeAt;
    Object.defineProperty(this, WORKFLOW_SUSPEND_BRAND, {
      value: true,
      enumerable: false,
      configurable: true,
    });
  }
}

/** What {@link replayRun} needs to run one body. */
export type ReplayOptions = {
  runId: string;
  /** The declared key, which is also the run record's `workflow`. */
  workflow: string;
  /**
   * The validated input, as stored on the run record.
   *
   * A RECORD, not `unknown`, and that is a real constraint rather than a
   * convenience: a workflow's input schema is an object schema
   * (`ToolInputSchema`), so a validated input is always an object. The store
   * hands back `unknown` because it crossed a wire, and the caller checks — see
   * `workflow-engine.ts`, where a non-record input fails the run rather than
   * being cast into place.
   */
  input: Record<string, unknown>;
  /** The body. Looked up by the caller, which owns the registry. */
  run: (input: Record<string, unknown>, ctx: WorkflowCtx) => Promise<unknown> | unknown;
  journal: JournalStore;
  /**
   * Where `report()` writes. Optional: a spec driving a body directly has no
   * reader, and a body that reports into nothing is not an error.
   */
  streams?: StreamStore | undefined;
  /**
   * Cancellation. Checked before each step EXECUTES — never mid-step, since a
   * step is the unit this engine can neither interrupt nor un-journal. A run
   * cancelled while a step is in flight therefore finishes that step and stops
   * at the next one, which is the honest guarantee.
   */
  signal?: AbortSignal | undefined;
  /**
   * How many step bodies may EXECUTE at once, across this whole process.
   *
   * Absent, a step runs the moment the body reaches it — which is what a body's
   * own fan-out width then means, and is the regression `workflow-step-gate.ts`
   * documents: the DevKit's world bounded execution and the engine inherited no
   * such bound. Every production caller passes one.
   */
  gate?: StepGate | undefined;
};

/**
 * What to record when a body swallowed its own suspend.
 *
 * Names the remedy rather than the symptom, because the symptom is whatever the
 * body did next and the cause is one line in a `catch`.
 */
function swallowedSuspend(err: unknown): string {
  const after = err === undefined ? "returned a value" : `threw: ${errorMessage(err)}`;
  return (
    `This workflow caught the engine's suspend signal and ${after}. ` +
    "A catch in a workflow body must test it with isWorkflowSuspend from " +
    "@alexkroman1/aai and throw it again — otherwise the body's failure path " +
    "runs against a run that was only waiting."
  );
}

/**
 * The absolute moment a `sleep(until)` names.
 *
 * A `Date` is taken as given; a number is a DURATION from now. Read once, at the
 * first reach, and journaled — see `JournalStore.claimSleep`.
 */
function wakeAtFrom(until: number | Date): number {
  return until instanceof Date ? until.getTime() : Date.now() + until;
}

/**
 * What the body's own throw MEANS, once the walk's two flags are in hand.
 *
 * Extracted from {@link replayRun}'s `catch` rather than inlined, because the
 * arms are a decision procedure with a fixed ORDER and nothing else in that
 * function shares state with them — and inlined they took `replayRun` over
 * Biome's cognitive-complexity ceiling, the same seam
 * `workflow-replay-step.ts` was split at.
 *
 * `undefined` means "this is not this function's business": an abort is the
 * caller's own signal coming back out, and `replayRun` re-throws it.
 */
function classifyThrow(
  err: unknown,
  walk: {
    signal: AbortSignal | undefined;
    refused: string | undefined;
    suspendThrown: boolean;
  },
): ReplayOutcome | undefined {
  // The run was cancelled and its status is already whatever cancelled it.
  if (walk.signal?.aborted && err === walk.signal.reason) return undefined;
  // A suspend is not a failure: the run is mid-flight and the caller schedules
  // its next delivery.
  if (isWorkflowSuspend(err)) {
    return { kind: "suspended", wakeAt: err instanceof SuspendSignal ? err.wakeAt : undefined };
  }
  // A REFUSAL the engine raised about this walk wins over everything below, and
  // over whatever the body threw after swallowing it. Three raise one: a
  // divergence — once the walk has read a key the run never reached, every later
  // line ran against a body that had lost its place, so its own failure
  // describes a consequence rather than the cause — a step whose budget is
  // held by attempts that never ended (`StepAbandonedError`), where the body
  // never ran at all and whatever it did instead is not the finding — and a wait
  // reached inside a step, where every wait AFTER it would read the wrong record.
  if (walk.refused !== undefined) return { kind: "failed", error: { message: walk.refused } };
  // A suspend went out and something ELSE came back: the body caught it. Fail
  // rather than recording the failure it happens to have thrown, because the
  // interesting fact is the swallow — everything the body did on its failure
  // path ran against a run that was only waiting.
  if (walk.suspendThrown) return { kind: "failed", error: { message: swallowedSuspend(err) } };
  return { kind: "failed", error: { message: errorMessage(err) } };
}

/**
 * Run one workflow body to a terminal answer.
 *
 * Never throws for an ordinary failure — a body that throws resolves
 * `{ kind: "failed" }`, because "the run failed" is an ANSWER the caller records
 * rather than an exception it has to classify. It does propagate a failure of
 * the JOURNAL itself: if the store is unreachable, the run's state is unknown
 * and the right move is to let the delivery fail and be retried, not to mark a
 * run failed on the strength of a database blip.
 *
 * @internal
 */
export async function replayRun(options: ReplayOptions): Promise<ReplayOutcome> {
  const { runId, workflow, input, journal, signal } = options;

  // One read for the whole replay — see `JournalStore`'s doc for why this is not
  // a lookup per step. Indexed by `key`, which is what `ctx.step` computes.
  const settled = new Map<string, StepEntry>();
  const entries = await journal.readSteps(runId);
  for (const entry of entries) settled.set(entry.key, entry);
  // What this walk has read out of the journal, and whether reaching a key the
  // run never reached is evidence the body has lost its place. Seeded from the
  // read above and from nothing this walk appends — see the module.
  const divergence = watchDivergence(entries);

  // How many times each NAME has been reached in this execution. Reset per call
  // because it is a property of the walk, not of the run — a replay walks the
  // same names in the same order and so recomputes the same keys.
  const occurrences = new Map<string, number>();

  // Sleeps are counted positionally rather than by name — a wait has no name, so
  // there is nothing to key a map on. Same replay property: the body walks the
  // same sleeps in the same order, so the Nth reach is the Nth wait.
  let sleeps = 0;
  let hooks = 0;
  /**
   * Whether a suspend was thrown during THIS walk.
   *
   * The other half of `sdk/workflow-suspend.ts`'s two defences. A body that
   * catches a suspend and does not re-throw has run its failure path against a
   * run that was merely waiting — `recap-workflow`'s saga deleted the transcript
   * it was waiting for — and the engine can see that without a build scan: a
   * suspend went out, and something other than a suspend came back.
   */
  let suspendThrown = false;
  /**
   * The message of a refusal the ENGINE raised about this walk, once one has.
   *
   * Three raise one, and each is a verdict about the walk rather than about a
   * step: a DIVERGENCE (a key the run never reached, while work it has done is
   * still unread), an ABANDONED step (its whole budget held by attempts that
   * never ended, so the body was not run at all), and a WAIT INSIDE A STEP,
   * which is a body the engine cannot execute correctly at all — see
   * `workflow-replay-wait.ts`.
   *
   * Held rather than merely thrown, for the reason `suspendThrown` is: JavaScript
   * `catch` catches everything, and one shipped template wraps its whole body in
   * a `try`/`catch` — so a refusal a body swallows would come back out as
   * `completed`, which is the exact silence this check exists to end.
   */
  let refused: string | undefined;
  /** Record one. A callback, because `refused` is a variable and not a field. */
  const setRefused = (message: string) => {
    refused = message;
  };

  const gate = options.gate;

  const ctx: WorkflowCtx = {
    runId,
    workflow,
    // `ctx.now`/`ctx.random`/`ctx.uuid`, each journaled under its own positional
    // key. Their key space, their absent attempt lease and their part in the
    // divergence check are argued in `workflow-replay-determinism.ts`.
    ...createDeterminismReads({ runId, journal, settled, divergence, refuse: setRefused }),
    async step<T>(name: string, fn: () => Promise<T> | T, stepOptions?: StepOptions): Promise<T> {
      // IDENTITY first: which journal key is this call? See `WorkflowCtx` in the
      // SDK for why it is a name plus an occurrence count.
      const occurrence = occurrences.get(name) ?? 0;
      occurrences.set(name, occurrence + 1);
      const key = `${name}#${occurrence}`;
      // Read BEFORE the answer, so "the journal still holds work" is snapshotted
      // in ISSUE order. A fan-out issues its keys synchronously and settles them
      // in any order, so a sibling reached a microtask later would otherwise
      // drain the set out from under this check and hide a real divergence.
      const refusal = divergence.reach(key, name, settled.get(key));

      // The journal is authoritative, and this arm runs BEFORE the abort check:
      // answering a settled step from the journal is free and deterministic, and
      // refusing to would stop a cancelled run replaying far enough to record
      // why it stopped.
      const entry =
        settled.get(key) ??
        (await runStepAttempts({
          runId,
          name,
          key,
          maxAttempts: stepOptions?.maxAttempts ?? DEFAULT_STEP_MAX_ATTEMPTS,
          journal,
          signal,
          // GATED around the attempt loop rather than around `fn`, so a step
          // holds its slot across its own retries. Re-queueing between attempts
          // would let a fan-out's stragglers interleave with fresh work and
          // defeat the bound at exactly the moment it matters — when a provider
          // is rate-limiting and every step is retrying.
          //
          // The journal reads above the gate are deliberately outside it: a
          // settled step answers from `settled`/`readSteps` without executing
          // anything, and making it queue behind live work would make a replay
          // of a long finished run as slow as the run.
          gate,
          // Only ever supplied when the journal has unread work: with none, an
          // unseen key is ordinary new work and there is nothing to refuse.
          // `onFirstReach` fires only when `claimAttempt` answers 1 — see its
          // doc for why a claimed attempt is what exonerates a crashed fan-out.
          onFirstReach:
            refusal === undefined
              ? undefined
              : () => {
                  refused = refusal.message;
                  throw refusal;
                },
          // The other refusal, recorded for the same reason: the step was never
          // run, so whatever a body that catches does next describes a
          // consequence rather than the cause. See `StepAbandonedError`.
          onAbandoned: (message) => {
            refused = message;
          },
          // The key was reached UNANSWERED — `settled` had nothing — and turned
          // out to be journaled anyway, so the divergence cursor has to advance
          // as if the snapshot had held it. Without this, a nested step answered
          // on that path leaves its children displaced and the next
          // first-reached key is refused on a healthy run.
          onAnsweredLate: (late) => divergence.answeredLate(late),
          fn,
        }));
      settled.set(key, entry);

      if (entry.status === "failed") throw stepFailure(entry);
      // The STORE's entry, not this execution's own value: a redelivery that
      // raced this one may have appended first, and both executions must return
      // the same thing or the two replays diverge from here on.
      return entry.output as T;
    },

    async sleep(until: number | Date, sleepOptions?: SleepOptions): Promise<void> {
      // BEFORE the counter advances: a step body may not wait, and the two ways
      // that used to go wrong are in `workflow-replay-wait.ts`.
      const noWait = waitInsideStep("ctx.sleep");
      if (noWait) {
        refused = noWait.message;
        throw noWait;
      }
      // Sleeps get their own key space rather than sharing the step counter, so
      // an author's step LITERALLY named "sleep" (`sleep#0`) cannot alias a
      // durable wait (`sleep!0`). `!` is not producible by `${name}#${n}`.
      const occurrence = sleeps;
      sleeps++;
      const record = await journal.claimSleep(
        runId,
        `sleep!${occurrence}`,
        wakeAtFrom(until),
        sleepOptions?.correlationId,
      );
      // Woken early, or the moment has passed — either way the wait is over. A
      // deadline in the past is not an error: a run resuming after a long outage
      // meets that case legitimately, and so does every replay after the wake.
      if (record.woken || Date.now() >= record.wakeAt) return;
      suspendThrown = true;
      throw new SuspendSignal(record.wakeAt);
    },

    async waitFor<T>(token: string, waitOptions?: WaitForOptions): Promise<T | undefined> {
      // Same refusal as `sleep` above, and for the same two reasons — a hook's
      // `hook!N` key space shifts exactly like a sleep's, and reading a
      // predecessor's record here hands the body somebody else's PAYLOAD.
      const noWait = waitInsideStep("ctx.waitFor");
      if (noWait) {
        refused = noWait.message;
        throw noWait;
      }
      // Its own key space again, for the reason sleeps have one.
      const occurrence = hooks;
      hooks++;
      const record = await journal.claimHook(runId, `hook!${occurrence}`, token);
      // The FIRST payload, every replay. `claimHook` is idempotent on the key, so
      // a re-walk reads what was delivered rather than registering a second wait.
      if (record.delivered) return record.payload as T;

      // No deadline: nothing but a signal ends this.
      if (waitOptions === undefined) {
        suspendThrown = true;
        throw new SuspendSignal(undefined);
      }

      // A DEADLINE is journaled as its own sleep, sharing the hook's occurrence
      // so the two travel together. That is what makes the window immune to
      // replay: the wake time is decided the first time this wait is reached,
      // where a `Promise.race` against a fresh `ctx.sleep` would restart it on
      // every delivery and the window would never close.
      const deadline = await journal.claimSleep(
        runId,
        `hookTimeout!${occurrence}`,
        Date.now() + waitOptions.timeoutMs,
        undefined,
        // Not an ordinary sleep: a bare `wakeUp(runId)` cuts a SCHEDULE short and
        // must not also close an approval window. See `SleepRecord.kind`.
        "hookTimeout",
      );
      // Closed unanswered. The hook is CLOSED before the body continues, so a
      // signal arriving a moment later cannot make the next replay read a
      // payload and take the answered branch — see `HookRecord.closed`.
      // `undefined` rather than a throw: a window closing is an outcome a body
      // branches on, not a failure.
      if (deadline.woken || Date.now() >= deadline.wakeAt) {
        // The close is a COMPARE-AND-SET, and its answer is what decides the
        // branch. A signal really can land between the deadline read above and
        // this line, and closing over it was the divergence `HookRecord.closed`
        // exists to prevent arriving by the other door: this walk would time out
        // while every later replay read `delivered: true` and answered.
        if (await journal.closeHook(runId, `hook!${occurrence}`)) return undefined;
        // Refused, so the window was ANSWERED. Re-read it — `claimHook` is
        // idempotent on the key, so this is the same read the next replay makes,
        // which is exactly the point.
        const answered = await journal.claimHook(runId, `hook!${occurrence}`, token);
        return answered.payload as T;
      }
      suspendThrown = true;
      throw new SuspendSignal(deadline.wakeAt);
    },
  };

  let completed: ReplayOutcome = { kind: "completed", output: undefined };
  try {
    const output = await withRunContext(
      {
        runId,
        workflow,
        write: (namespace, value) =>
          options.streams?.write(runId, streamNamespace(namespace), value) ?? Promise.resolve(-1),
      },
      async () => options.run(input, ctx),
    );
    completed = { kind: "completed", output };
  } catch (err: unknown) {
    const outcome = classifyThrow(err, { signal, refused, suspendThrown });
    // `undefined` is the abort arm: the caller's signal, re-thrown.
    if (outcome === undefined) throw err;
    return outcome;
  }
  // Resolved NORMALLY after a refusal is the quieter half of the same bug, and
  // the one the measured reproduction actually took: the body caught the refusal
  // and carried on to an answer, so a run whose walk had already lost its place
  // reported `completed`.
  if (refused !== undefined) return { kind: "failed", error: { message: refused } };
  // Resolved NORMALLY after suspending, which is the quieter half of the same
  // bug: the body caught the suspend and carried on to an answer, so the output
  // describes a run that skipped its own wait.
  if (suspendThrown) {
    return { kind: "failed", error: { message: swallowedSuspend(undefined) } };
  }
  return completed;
}
