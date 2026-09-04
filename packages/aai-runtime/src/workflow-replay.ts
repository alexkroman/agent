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
 * ## Suspension is OUT OF BAND
 *
 * A body that must wait — `ctx.sleep`, `ctx.waitFor` — cannot return, because the
 * wait may be days long and the process must be free meanwhile. It is not thrown
 * out either: `catch` catches everything, and a body that swallowed the engine's
 * own signal ran its failure path against a run that was merely waiting, which
 * shipped and cost a transcript. A wait hands back a promise that never settles
 * and the walk suspends on a channel the body holds no reference to — the
 * {@link ReplayOptions} walk races the body against
 * `SuspendController.interruption`. `workflow-replay-suspend.ts` carries the
 * argument, the aggregation of concurrent waits, and what quiescence means here.
 *
 * The two wait METHODS are not here either. `workflow-replay-waits.ts` holds
 * them, split at the seam `createDeterminismReads` already drew — a
 * `Pick<WorkflowCtx, …>` factory bound to one walk — and it carries the key
 * grammar (`sleep!<label>#<occurrence>`, `hook!<token>#<occurrence>`) and what
 * naming the waits closed. What is left here is the STEP, which is the one
 * method whose identity the walk itself decides.
 */

import { randomUUID } from "node:crypto";
import { DEFAULT_STEP_MAX_ATTEMPTS, type StepOptions, type WorkflowCtx } from "@alexkroman1/aai";
import type { Logger } from "./runtime-config.ts";
import { describeCodeChange } from "./workflow-code-version.ts";
import { journalBound, WORKFLOW_JOURNAL_MAX_STEPS } from "./workflow-journal-bound.ts";
import type { JournalStore, SleepEntry, SleepRecord, StepEntry } from "./workflow-journal-types.ts";
import { createDeterminismReads } from "./workflow-replay-determinism.ts";
import { watchDivergence } from "./workflow-replay-divergence.ts";
import { watchJournalFailure } from "./workflow-replay-journal-failure.ts";
import { classifyThrow, type ReplayOutcome } from "./workflow-replay-outcome.ts";
import { journaledStepOutput } from "./workflow-replay-schema.ts";
import { runStepAttempts, stepFailure } from "./workflow-replay-step.ts";
import { createSuspendController } from "./workflow-replay-suspend.ts";
import { createWaitMethods } from "./workflow-replay-waits.ts";
import { withRunContext } from "./workflow-run-context.ts";
import type { StepGate } from "./workflow-step-gate.ts";
import { type StreamStore, streamNamespace } from "./workflow-streams.ts";

// Re-exported at the surface it has always had — see `workflow-replay-outcome.ts`.
// `export ... from` rather than exporting the imported binding: the import above
// is for this module's OWN use of the type, and Biome's `noExportedImports`
// wants the re-export to name its source.
export type { ReplayOutcome } from "./workflow-replay-outcome.ts";

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
  /**
   * The run record's `codeVersion` — which bundle the run was STARTED against.
   *
   * Read for one purpose: a divergence message that states whether the code
   * moved instead of handing the reader a test. Absent means unknown (a run
   * predating the field, or a server with no bundle hash), and an unknown must
   * never read as unchanged — `workflow-code-version.ts` carries why.
   */
  startedUnder?: string | undefined;
  journal: JournalStore;
  /**
   * This walk's step snapshot, already in flight.
   *
   * On a deployed agent the opening read below is a
   * `POST /:slug/workflow-journal` — one of THREE the engine takes
   * SEQUENTIALLY before a body runs (`getRun`, the `running` compare-and-set,
   * then this) at ~840 ms each. Nothing about it depends on the other two, so
   * `workflow-engine.ts` issues it beside the CAS and hands the promise down.
   * Optional: a caller with nothing to overlap it with passes nothing.
   */
  /**
   * WHOSE attempt charges this walk takes. Defaults to a fresh id.
   *
   * An option only so a spec can name it — a harness that wants to model two
   * walks of one run needs two holders, and a harness that wants to model a
   * REDELIVERY of the same walk needs one. Production never passes it: a walk
   * that inherited another's holder would inherit its charge, and the ceiling
   * would stop counting the thing it exists to count.
   */
  holder?: string | undefined;
  steps?: Promise<StepEntry[]> | undefined;
  /**
   * This walk's WAIT snapshot, already in flight — the other half of
   * {@link ReplayOptions.steps}, issued at the same moment and for the same
   * reason.
   *
   * It buys more than the step read does, because what it removes is not one
   * round trip but N: a body that sleeps in a loop reaches every one of its
   * ELAPSED sleeps again on the next delivery, and each of those used to be its
   * own `claimSleep`. See `workflow-replay-waits.ts` for the rule deciding which
   * of them this snapshot may answer.
   *
   * Optional on the same terms: a caller with nothing to overlap it with passes
   * nothing and the read is taken here.
   */
  sleeps?: Promise<SleepEntry[]> | undefined;
  /**
   * Where `stepReport()` writes. Optional: a spec driving a body directly has no
   * reader, and a body that reports into nothing is not an error.
   */
  streams?: StreamStore | undefined;
  /**
   * Where a walk's own WARNINGS go — today only the journal-growth one
   * (`workflow-journal-bound.ts`).
   *
   * Optional for the same reason `streams` is: a spec driving a body directly has
   * no logger, and a warning nobody reads is not an error. The engine passes its
   * own, which is the only path a deployed run takes.
   */
  logger?: Logger | undefined;
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
 * Run one workflow body to a terminal answer.
 *
 * Never throws for an ordinary failure — a body that throws resolves
 * `{ kind: "failed" }`, because "the run failed" is an ANSWER the caller records
 * rather than an exception it has to classify. It does propagate a failure of
 * the JOURNAL itself: if the store is unreachable, the run's state is unknown
 * and the right move is to let the delivery fail and be retried, not to mark a
 * run failed on the strength of a database blip.
 *
 * **That second sentence used to be true only of `readSteps`.** Every other
 * journal call the engine makes is reached FROM the body, so its rejection
 * unwound through the body like any other throw and `classifyThrow` had nothing
 * to tell it from an exception the body raised — a store that blinked marked a
 * healthy run TERMINALLY failed, discarding a step that had already succeeded.
 * `workflow-replay-journal-failure.ts` is what makes the sentence true: the
 * store is wrapped once, any rejection is recorded on the walk, and this
 * re-throws it — including when the body swallowed it. Its one exemption is a
 * `JournalConflictError`, which is a verdict about the RUN rather than the
 * store and must still fail it.
 *
 * @internal
 */
export async function replayRun(options: ReplayOptions): Promise<ReplayOutcome> {
  const { runId, workflow, input, signal } = options;
  // Every journal call this walk makes goes through the watch, so a rejection is
  // recorded before it unwinds — see `workflow-replay-journal-failure.ts`. It is
  // shadowed deliberately: nothing below may reach the raw store, or a new
  // journal call would be silently exempt from the rule.
  const journalWatch = watchJournalFailure(options.journal);
  const journal = journalWatch.journal;
  // WHOSE attempt charges this walk takes. One id for the whole walk, not one
  // per step: a charge attributes the WALK, so one that dies takes every charge
  // it holds with it and one that reaches a key twice must not pay twice. See
  // `JournalStore.claimAttempt`, and `ATTEMPT_LEASE_MS` for how long a charge
  // outlives the walk that abandoned it.
  const holder = options.holder ?? randomUUID();

  // One read for the whole replay — see `JournalStore`'s doc for why this is not
  // a lookup per step. Indexed by `key`, which is what `ctx.step` computes.
  const settled = new Map<string, StepEntry>();
  const sleeps = new Map<string, SleepRecord>();
  // ISSUED TOGETHER, then awaited — the two are independent reads of one run id
  // and nothing here needs the first to decide the second. `workflow-engine.ts`
  // already starts both beside its `running` compare-and-set, so the prefetched
  // path was already one round trip; a caller that passes neither (`aai dev`'s
  // own dispatcher on a host-supplied journal, the eval engine, every harness)
  // took them SEQUENTIALLY because the second call was not even made until the
  // first resolved. Same reads, one latency.
  const stepsRead = options.steps ?? journal.readSteps(runId);
  const sleepsRead = options.sleeps ?? journal.readSleeps(runId);
  // A rejection belongs to whoever awaits it. The no-op catch is only so the
  // `await` below rejecting first cannot leave the other one unhandled — which
  // by default ends the process (`scripts/fail-on-process-warning.mjs` makes it
  // a test failure), and is the same guard `workflow-engine.ts` puts on the pair
  // it prefetches.
  void stepsRead.catch(() => undefined);
  void sleepsRead.catch(() => undefined);
  // Awaited here whether the caller prefetched or not, so the ordering below is
  // identical either way: an overlapped read is the SAME read, started earlier —
  // see `ReplayOptions.steps`.
  const entries = await stepsRead;
  for (const entry of entries) settled.set(entry.key, entry);
  // The WAIT half of the same snapshot — see `ReplayOptions.sleeps`. Awaited
  // beside the steps rather than lazily at the first wait, so a wait's answer
  // never costs a round trip mid-walk.
  for (const record of await sleepsRead) sleeps.set(record.key, record);
  // BEFORE the body runs, because the point is not to start work this run cannot
  // finish — a walk of a journal at the ceiling is the slowest thing the engine
  // does and the least likely to reach an end. A refusal is an ordinary `failed`
  // outcome rather than a throw: the engine already writes one and the run has a
  // real verdict, where a throw would leave it `running` for the sweep to find.
  const bound = journalBound(entries.length);
  if (bound.kind === "refuse") return { kind: "failed", error: { message: bound.message } };
  if (bound.kind === "warn") {
    options.logger?.warn(bound.message, {
      runId,
      workflow: options.workflow,
      steps: bound.steps,
      ceiling: WORKFLOW_JOURNAL_MAX_STEPS,
    });
  }

  // What the run record says about the CODE, read once. Two refusals narrate
  // themselves with it and each states a different conclusion from the same
  // three-way verdict — a divergence and a journaled output that no longer
  // satisfies its step's schema. See `workflow-code-version.ts`.
  const code = describeCodeChange(options.startedUnder);
  // What this walk has read out of the journal, and whether reaching a key the
  // run never reached is evidence the body has lost its place. Seeded from the
  // read above and from nothing this walk appends — see the module.
  const divergence = watchDivergence(entries, code);

  // How many times each NAME has been reached in this execution. Reset per call
  // because it is a property of the walk, not of the run — a replay walks the
  // same names in the same order and so recomputes the same keys.
  const occurrences = new Map<string, number>();

  /**
   * Where a wait PARKS, and the channel the walk suspends on.
   *
   * One per walk, so its suspension value is unique to this call and can be
   * recognised by identity. See `workflow-replay-suspend.ts` — the body holds no
   * reference to any of it, which is the whole point.
   */
  const suspend = createSuspendController();
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
   * Held rather than merely thrown, because JavaScript `catch` catches
   * everything and one shipped template wraps its whole body in a `try`/`catch`
   * — so a refusal a body swallows would come back out as `completed`, which is
   * the exact silence this check exists to end. A REFUSAL still travels as a
   * throw, unlike a suspension: it is a verdict the body may usefully see
   * (`stepFailure` is the same channel), and this field is what stops the body
   * having the last word on it.
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
    ...createDeterminismReads({
      runId,
      journal,
      settled,
      divergence,
      refuse: setRefused,
      hold: suspend.hold,
    }),
    // `ctx.sleep`/`ctx.waitFor`, each keyed by NAME under its own `!` space.
    // Split out for the reason the reads above are — see
    // `workflow-replay-waits.ts`, which also carries what naming the waits
    // closed and the one residual it did not.
    ...createWaitMethods({ runId, workflow, journal, sleeps, suspend, refuse: setRefused }),
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
      //
      // `suspend.hold` keeps the walk OPEN for the attempt loop. A sibling wait
      // that parks meanwhile — `Promise.all([ctx.step(…), ctx.sleep(…)])` — must
      // not suspend the delivery out from under work in flight: the step would
      // go unjournaled and the next delivery would run it again. It is also what
      // replaced the attempt loop's release-on-suspend arm, which existed only
      // because a suspend used to unwind THROUGH a running step.
      const entry =
        settled.get(key) ??
        (await suspend.hold(() =>
          runStepAttempts({
            runId,
            name,
            key,
            maxAttempts: stepOptions?.maxAttempts ?? DEFAULT_STEP_MAX_ATTEMPTS,
            journal,
            holder,
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
            // The WRITE half of `StepOptions.schema`: checked before the entry is
            // appended, and a rejection is the step's own failure. The read half
            // is below — see `workflow-replay-schema.ts` for why the same schema
            // means two different verdicts on the two sides of the journal.
            schema: stepOptions?.schema,
            fn,
          }),
        ));
      settled.set(key, entry);

      if (entry.status === "failed") throw stepFailure(entry);
      // The STORE's entry, not this execution's own value: a redelivery that
      // raced this one may have appended first, and both executions must return
      // the same thing or the two replays diverge from here on. Which is exactly
      // why the schema is checked HERE as well as at the write: this value may
      // have been produced by another walk, or by another BUNDLE days ago, and
      // until now it reached the body as a bare cast.
      return (await journaledStepOutput({
        entry,
        name,
        key,
        schema: stepOptions?.schema,
        code,
        refuse: setRefused,
      })) as T;
    },
  };

  let completed: ReplayOutcome = { kind: "completed", output: undefined };
  try {
    const output = await withRunContext(
      {
        runId,
        workflow,
        // HELD like a journal call, so a `stepReport()` between two waits cannot be
        // mistaken for quiescence and suspend the walk before the second one is
        // reached. It is the one piece of engine work a BODY can start directly.
        write: async (namespace, value) => {
          const slot = suspend.enter();
          try {
            return (await options.streams?.write(runId, streamNamespace(namespace), value)) ?? -1;
          } finally {
            slot.end();
          }
        },
      },
      // The body is RACED against the interruption rather than thrown into. It
      // is a `race` and not a `p-timeout`: nothing here is a deadline — the
      // other side is the walk's own suspension channel, which settles when the
      // body has parked. See `workflow-replay-suspend.ts`.
      async () => Promise.race([options.run(input, ctx), suspend.interruption]),
    );
    completed = { kind: "completed", output };
  } catch (err: unknown) {
    const outcome = classifyThrow(err, {
      signal,
      refused,
      journalFailed: journalWatch.failure() !== undefined,
      suspend,
    });
    // `undefined` is the abort arm: the caller's signal, re-thrown.
    if (outcome === undefined) throw err;
    return outcome;
  }
  // Resolved NORMALLY after a journal failure is the same quiet half, and for a
  // journal it is worse than for a refusal: the body swallowed the rejection and
  // answered, so the run would be marked `completed` carrying a step the store
  // never recorded — which the next read of that journal cannot reproduce.
  // Re-thrown as it arrived, so the delivery is retried.
  const journalFailure = journalWatch.failure();
  if (journalFailure !== undefined) throw journalFailure;
  // Resolved NORMALLY after a refusal is the quieter half of the same bug, and
  // the one the measured reproduction actually took: the body caught the refusal
  // and carried on to an answer, so a run whose walk had already lost its place
  // reported `completed`.
  if (refused !== undefined) return { kind: "failed", error: { message: refused } };
  // There is no companion check for a suspension any more, and its absence is
  // the whole point: a body cannot resolve THROUGH a wait, because a parked wait
  // hands it a promise that never settles. What used to need a post-hoc "did the
  // body swallow it" test is now unrepresentable.
  return completed;
}
