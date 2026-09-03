// Copyright 2026 the AAI authors. MIT license.
/**
 * `procedure()` — run a state machine to completion as one unit of work.
 *
 * The other half of {@link dialog}, and the distinction is worth getting straight
 * because both are machines:
 *
 * - A {@link dialog} is WHERE A CONVERSATION IS. It is persisted in a session
 *   slot, it moves one event at a time, and the caller's turns are what move it.
 * - A `procedure()` is ONE UNIT OF WORK inside a single tool call. It drives itself
 *   to completion through invoked actors, it is never stored, and its context
 *   may therefore hold things no slot could — a `GenerateFn`, an open client.
 *
 * A retrieve-grade-rewrite loop, a plan-critique-revise pass, a multi-stage
 * classification: work with real branching, where the branches are the design.
 * The machine is the declarative artifact and stays the author's — this is not a
 * DSL over XState, and inventing one would only lose guards, nested states and
 * parallel regions. What this owns is the LIFECYCLE, which is the part that has
 * no business being retyped in a tool body.
 *
 * ## Why this is not three lines a tool can write itself
 *
 * It looks like `createActor` + `start` + `toPromise`, and the third of those
 * has a trap that a tool body written the obvious way walks straight into:
 *
 * **`toPromise` on a STOPPED actor RESOLVES WITH `undefined`.** It does not
 * reject and it does not hang — verified against xstate 5.32. So a procedure
 * abandoned part-way (see `signal`) hands back `undefined` typed as the
 * machine's own output, and the tool goes on to read fields off it as though the
 * work had finished. `run` checks the actor's final status instead and throws,
 * so an unfinished procedure cannot be mistaken for a finished one.
 *
 * That is the whole argument for the wrapper. The lifecycle is short and it is
 * wrong in a way nothing at the call site shows.
 *
 * @module procedure
 */

import { type AnyStateMachine, createActor, type InputFrom, type OutputFrom } from "xstate";

/** Options for one {@link Procedure.run}. */
export interface ProcedureRunOptions {
  /**
   * Abort the run — pass `ctx.signal` and a barge-in stops the procedure.
   *
   * This is the reason a long procedure should be run through here rather than by
   * hand. A CRAG loop is five to nine model calls; a caller who interrupts on
   * the second is charged for the remaining seven unless something stops it, and
   * `ctx.signal` is already aborted on barge-in, reset and session stop. Aborting
   * stops the actor, which cancels nothing already in flight but issues nothing
   * further, and `run` then throws rather than returning a half-built output.
   */
  signal?: AbortSignal;
}

/**
 * A machine that can be run as a unit of work, created by {@link procedure}.
 *
 * @typeParam M - The XState machine.
 *
 * @public
 */
export interface Procedure<M extends AnyStateMachine> {
  /** The machine itself, for a caller that wants to inspect or visualize it. */
  readonly machine: M;
  /**
   * Run to completion and resolve with the machine's `output`.
   *
   * Rejects when the machine ENDS badly rather than when it decides badly: an
   * invoked actor whose promise rejects with no `onError` stops the machine and
   * rejects here, and so does an aborted or otherwise unfinished run. A machine
   * that reached a final state resolves — so every way of *failing at the work*
   * should be a final state whose output says so, which is what keeps a procedure's
   * failures inspectable instead of thrown.
   */
  run(input: InputFrom<M>, options?: ProcedureRunOptions): Promise<OutputFrom<M>>;
}

/**
 * The error a run that did not finish rejects with.
 *
 * Its own class because the two ways to not finish — aborted by a caller, or
 * stopped for any other reason — are the same fact to a tool body (there is no
 * output) and different facts to a log.
 *
 * @public
 */
export class ProcedureNotFinishedError extends Error {
  /** The machine's id, so a log names which procedure stopped. */
  readonly procedure: string;
  /** Whether the run's `signal` is what ended it. */
  readonly aborted: boolean;

  constructor(procedure: string, aborted: boolean) {
    super(
      aborted
        ? `The "${procedure}" procedure was aborted before it finished.`
        : `The "${procedure}" procedure stopped before reaching a final state.`,
    );
    this.name = "ProcedureNotFinishedError";
    this.procedure = procedure;
    this.aborted = aborted;
  }
}

/**
 * Wrap a machine so a tool body can run it without touching an actor.
 *
 * @param machine - An ordinary XState machine. Give it an `output` — that is
 *   what {@link Procedure.run} resolves with, and a machine with none resolves
 *   `undefined`.
 *
 * @example
 * ```ts
 * import { procedure, tool } from "@alexkroman1/aai";
 * import { setup } from "xstate";
 * import { z } from "zod";
 *
 * const machine = setup({
 *   types: {} as { input: { topic: string }; output: { verdict: string } },
 * }).createMachine({
 *   id: "triage",
 *   initial: "deciding",
 *   context: ({ input }) => ({ topic: input.topic }),
 *   states: { deciding: { type: "final" } },
 *   output: ({ context }) => ({ verdict: `looked at ${context.topic}` }),
 * });
 *
 * const triage = procedure(machine);
 *
 * export default tool({
 *   description: "Triage a topic",
 *   inputSchema: z.object({ topic: z.string() }),
 *   // `ctx.signal` is what makes a barge-in stop the procedure mid-run.
 *   execute: async ({ topic }, ctx) => await triage.run({ topic }, { signal: ctx.signal }),
 * });
 * ```
 *
 * @remarks
 * **Three primitives here run a defined process; pick by SCOPE.** A
 * {@link dialog} gates a CONVERSATION — what the agent may say or do next,
 * across turns, persisted in a session slot. A {@link procedure} runs ONE UNIT
 * OF WORK inside a single tool call, never stored. A {@link workflow} runs
 * DURABLY, outliving the session.
 *
 * @public
 */
export function procedure<M extends AnyStateMachine>(machine: M): Procedure<M> {
  return {
    machine,
    run: (input, options) =>
      new Promise<OutputFrom<M>>((resolve, reject) => {
        const signal = options?.signal;
        const id = String(machine.id);
        if (signal?.aborted) {
          reject(new ProcedureNotFinishedError(id, true));
          return;
        }
        // WIDENED to `AnyStateMachine`, as `sdk/dialog.ts` does and for the same
        // reason: `SnapshotFrom<M>` for a still-generic `M` resolves to nothing
        // with members, so `.status` and `.output` are errors through the narrow
        // type. It is an assignment rather than an assertion, and `M` survives
        // where it is worth having — on `machine`, and on `run`'s input and
        // output, which is what types an author's call.
        const logic: AnyStateMachine = machine;
        const actor = createActor(logic, { input });

        const onAbort = () => actor.stop();
        signal?.addEventListener("abort", onAbort, { once: true });
        const done = () => signal?.removeEventListener("abort", onAbort);

        // `subscribe`'s complete callback rather than `toPromise`, because that
        // helper cannot tell the two endings apart — see the module doc. A
        // completed subscription fires for a machine that reached a final state
        // AND for one that was stopped, so the status is what decides.
        actor.subscribe({
          error: (error: unknown) => {
            done();
            reject(error);
          },
          complete: () => {
            done();
            const snapshot = actor.getSnapshot();
            if (snapshot.status === "done") {
              resolve(snapshot.output as OutputFrom<M>);
              return;
            }
            reject(new ProcedureNotFinishedError(id, signal?.aborted ?? false));
          },
        });

        actor.start();
      }),
  };
}
