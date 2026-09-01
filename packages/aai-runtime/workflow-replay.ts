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
 * ## What is NOT here
 *
 * Suspension. A body that must wait — a durable sleep, a hook — cannot do it in
 * this version: `replayRun` runs a body to a terminal answer or throws. Adding
 * it is Phase 2, and the shape is already cut for it — a suspend becomes a
 * distinguished throw that this function reports instead of failing the run,
 * and the journal already records enough to resume.
 */

import { DEFAULT_STEP_MAX_ATTEMPTS, type StepOptions, type WorkflowCtx } from "@alexkroman1/aai";
import { sleep } from "@alexkroman1/aai/host-internal";
import { FatalError, RetryableError } from "@alexkroman1/aai/step-errors";
import type { JournalStore, StepEntry } from "./workflow-journal-types.ts";
import { withRunContext, withStepContext } from "./workflow-run-context.ts";
import { DEFAULT_STREAM_NAMESPACE, type StreamStore } from "./workflow-streams.ts";

/**
 * The longest this will hold a worker waiting to retry a step.
 *
 * A `RetryableError` may name any delay — a rate limiter answering
 * `Retry-After: 300` is ordinary — and honouring it literally would park a
 * worker for five minutes on a run that is doing nothing. So a delay is CLAMPED
 * here, which means a long `retryAfter` is treated as a floor the engine
 * approximates rather than a promise it keeps.
 *
 * Stated plainly because it is the one place this engine is weaker than the
 * DevKit's, which re-enqueued instead of waiting. It stops being a compromise in
 * Phase 2: once a body can suspend, a delay over this cap becomes a suspend and
 * the wait costs nothing.
 */
export const MAX_IN_PROCESS_RETRY_MS = 30_000;

/** What a run's execution resolved to. */
export type ReplayOutcome =
  | { kind: "completed"; output: unknown }
  | { kind: "failed"; error: { message: string } };

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
};

/**
 * A step that settled `failed`, as an error to throw into the body.
 *
 * Reconstructed rather than stored: an `Error` does not survive the journal's
 * codec as a class, only as its message. That loses the original's `cause` and
 * its stack, which is a real cost and the right trade — the alternative is
 * serialising arbitrary error subclasses, which cannot be done faithfully and
 * fails silently when it is done badly.
 *
 * It is a `FatalError` deliberately: by the time an entry exists the step is
 * OVER, so a body that re-throws it must not cause a fresh retry cycle
 * somewhere above.
 */
function stepFailure(entry: StepEntry): Error {
  return new FatalError(entry.error?.message ?? `step ${entry.name} failed`);
}

/** How long to wait before a retryable step's next attempt, clamped. */
function retryDelay(err: unknown): number {
  const at = RetryableError.is(err) ? err.retryAfter.getTime() - Date.now() : 0;
  return Math.min(Math.max(at, 0), MAX_IN_PROCESS_RETRY_MS);
}

/** The message to record for a thrown value that may not be an `Error`. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * What {@link runStepAttempts} needs to settle one step.
 *
 * A bag rather than eight positional parameters, and it is the same set the
 * journal entry is built from — which is the point: an entry field added
 * without a way to fill it is a compile error here rather than a `undefined`
 * in a run's history.
 */
type StepAttemptOptions = {
  runId: string;
  name: string;
  key: string;
  maxAttempts: number;
  journal: JournalStore;
  signal: AbortSignal | undefined;
  fn: () => unknown;
};

/**
 * Run one step until it settles, and journal the entry that settled it.
 *
 * Extracted from `ctx.step` rather than inlined, because the two do genuinely
 * different jobs: `ctx.step` decides IDENTITY (which journal key is this call?)
 * and answers from the journal, and this decides ATTEMPTS. Keeping them in one
 * function put both decisions in one 60-line closure that Biome measured at
 * complexity 20, and the split is what a reader wants anyway — the retry policy
 * is the part with the interesting invariants.
 *
 * Resolves the settling entry, `ok` or `failed`. Never throws for a step
 * failure: the caller turns the entry into the throw, so the journal write and
 * the throw cannot come apart.
 */
async function runStepAttempts(options: StepAttemptOptions): Promise<StepEntry> {
  const { runId, name, key, maxAttempts, journal, signal, fn } = options;

  for (;;) {
    signal?.throwIfAborted();

    // Before the body, never after — see `JournalStore.claimAttempt`.
    const attempt = await journal.claimAttempt(runId, key);
    if (attempt > maxAttempts) {
      return journal.appendStep(runId, {
        key,
        name,
        status: "failed",
        error: { message: `step ${name} exhausted ${maxAttempts} attempt(s)` },
        attempts: attempt - 1,
        finishedAt: Date.now(),
      });
    }

    try {
      // Inside the step's own context, so a `report()` from the body or any
      // helper it calls is attributed to THIS step and this attempt.
      const output = await withStepContext({ name, key, attempt }, async () => fn());
      return journal.appendStep(runId, {
        key,
        name,
        status: "ok",
        output,
        attempts: attempt,
        finishedAt: Date.now(),
      });
    } catch (err: unknown) {
      if (!(FatalError.is(err) || attempt >= maxAttempts)) {
        await sleep(retryDelay(err));
        continue;
      }
      return journal.appendStep(runId, {
        key,
        name,
        status: "failed",
        error: { message: messageOf(err) },
        attempts: attempt,
        finishedAt: Date.now(),
      });
    }
  }
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
  for (const entry of await journal.readSteps(runId)) settled.set(entry.key, entry);

  // How many times each NAME has been reached in this execution. Reset per call
  // because it is a property of the walk, not of the run — a replay walks the
  // same names in the same order and so recomputes the same keys.
  const occurrences = new Map<string, number>();

  const ctx: WorkflowCtx = {
    runId,
    workflow,
    async step<T>(name: string, fn: () => Promise<T> | T, stepOptions?: StepOptions): Promise<T> {
      // IDENTITY first: which journal key is this call? See `WorkflowCtx` in the
      // SDK for why it is a name plus an occurrence count.
      const occurrence = occurrences.get(name) ?? 0;
      occurrences.set(name, occurrence + 1);
      const key = `${name}#${occurrence}`;

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
          fn,
        }));
      settled.set(key, entry);

      if (entry.status === "failed") throw stepFailure(entry);
      // The STORE's entry, not this execution's own value: a redelivery that
      // raced this one may have appended first, and both executions must return
      // the same thing or the two replays diverge from here on.
      return entry.output as T;
    },
  };

  try {
    const output = await withRunContext(
      {
        runId,
        workflow,
        write: (namespace, value) =>
          options.streams?.write(runId, namespace || DEFAULT_STREAM_NAMESPACE, value) ??
          Promise.resolve(-1),
      },
      async () => options.run(input, ctx),
    );
    return { kind: "completed", output };
  } catch (err: unknown) {
    // An abort is the caller's own signal coming back out, not a run failure —
    // the run was cancelled and its status is already whatever cancelled it.
    if (signal?.aborted && err === signal.reason) throw err;
    return { kind: "failed", error: { message: messageOf(err) } };
  }
}
