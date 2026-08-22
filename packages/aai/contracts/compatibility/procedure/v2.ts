// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:procedure` epoch 2.
 *
 * Epoch 2 is epoch 1 RENAMED: `graph()` is `procedure()`, `Graph` is
 * `Procedure`, `GraphRunOptions` is `ProcedureRunOptions`,
 * `GraphNotFinishedError` is `ProcedureNotFinishedError`, and that error's
 * `graph` field is `procedure`. The behaviour is unchanged — `run` still
 * resolves with the machine's `output`, still rejects when the machine ends
 * badly rather than when it decides badly, and `signal` is still what makes a
 * barge-in stop a five-to-nine-model-call loop.
 *
 * The rename says what the primitive is FOR rather than what it is made of. A
 * machine is the implementation; a unit of work you invoke and that returns is
 * the job. See `../dialog/v2.ts` for the other half of the same argument.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import { setup } from "xstate";
import { z } from "zod";

import { procedure, tool } from "../../../index.ts";

const machine = setup({
  types: {} as { input: { topic: string }; output: { verdict: string } },
}).createMachine({
  id: "triage",
  initial: "deciding",
  context: ({ input }) => ({ topic: input.topic }),
  states: { deciding: { type: "final" } },
  output: ({ context }) => ({ verdict: `looked at ${context.topic}` }),
});

/** The declaration: a machine, wrapped so a tool body never touches an actor. */
export const triage = procedure(machine);

export default tool({
  description: "Triage a topic",
  inputSchema: z.object({ topic: z.string() }),
  // `ctx.signal` is the reason to run a long one through here: a caller who
  // interrupts on the second model call is charged for the rest unless
  // something stops it.
  execute: async ({ topic }, ctx) => await triage.run({ topic }, { signal: ctx.signal }),
});
