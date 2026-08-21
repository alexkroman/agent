// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:graph` epoch 1.
 *
 * Epoch 1 is the primitive arriving. What an author writes at this epoch, and
 * what this file therefore has to keep compiling:
 *
 * - **The machine is an ordinary `xstate` machine**, declared with the author's
 *   own `input` and `output` types. The SDK re-exports nothing from xstate and
 *   is not a DSL over it — `graph()` wraps the LIFECYCLE and nothing else.
 * - **`run(input, { signal })`** is the whole surface. Passing `ctx.signal` is
 *   what makes a long graph interruptible, so a barge-in stops it.
 * - **`run` REJECTS for a run that did not finish**, with a
 *   {@link GraphNotFinishedError} carrying which graph and whether a caller
 *   aborted it. It never resolves a half-built output, which is the trap the
 *   primitive exists to close.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative. Editing this file to make a compile error go away defeats the
 * mechanism — the error IS the finding.
 */

import { fromPromise, setup } from "xstate";
import { z } from "zod";

import { GraphNotFinishedError, graph, isToolFailure, tool, toolFailure } from "../../../index.ts";

/** The machine: two stages, the second decided by the first. */
const machine = setup({
  types: {} as {
    input: { topic: string };
    output: { verdict: string; checked: number };
  },
  actors: {
    look: fromPromise(async ({ input }: { input: { topic: string } }) => ({
      hits: input.topic.length,
    })),
  },
}).createMachine({
  id: "triage",
  initial: "looking",
  context: ({ input }) => ({ topic: input.topic, hits: 0 }),
  states: {
    looking: {
      invoke: {
        src: "look",
        input: ({ context }) => ({ topic: context.topic }),
        onDone: {
          target: "settled",
          actions: ({ event, context }) => {
            context.hits = event.output.hits;
          },
        },
      },
    },
    settled: { type: "final" },
  },
  output: ({ context }) => ({
    verdict: context.hits > 0 ? "covered" : "nothing found",
    checked: context.hits,
  }),
});

export const triage = graph(machine);

/** A domain helper over the graph's own output type. */
export function reads(output: { verdict: string; checked: number }): string {
  return `${output.verdict} (${output.checked})`;
}

/**
 * The tool that runs it. `ctx.signal` goes in, and a run that did not finish
 * comes back as a failure the model can act on rather than as a half-output.
 */
export const triageTopic = tool({
  description: "Triage a topic against the knowledge base.",
  inputSchema: z.object({ topic: z.string() }),
  execute: async ({ topic }, ctx) => {
    try {
      return { summary: reads(await triage.run({ topic }, { signal: ctx.signal })) };
    } catch (err: unknown) {
      if (err instanceof GraphNotFinishedError && err.aborted) {
        return toolFailure("That lookup was interrupted.");
      }
      return toolFailure("That lookup failed.");
    }
  },
});

/** A graph's failure is an ordinary `ToolFailure`, so it narrows like any other. */
export function describe(result: { summary: string } | ReturnType<typeof toolFailure>): string {
  return isToolFailure(result) ? result.error : result.summary;
}
