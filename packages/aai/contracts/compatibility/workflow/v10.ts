// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:workflow` epoch 10.
 *
 * **`WorkflowClient` grew a method, and nothing else moved.** The export list is
 * identical to epoch 9's, so this is a SIGNATURE change; epoch 9 is RETAINED and
 * `./v9.ts` compiles unchanged beside this file, because every frozen example in
 * this tree only ever CALLS a `WorkflowClient` — none implements one, which is
 * the property that decides whether an added member is breaking.
 *
 * `ctx.workflows.lastLine(runId)` is the newest progress chunk, or `undefined`.
 * It exists because the composition it replaces HANGS. A progress channel is
 * never closed — no step knows it is the last one — so `stream()` on a run that
 * has written nothing yields nothing and waits forever: a voice agent's tool
 * call stops mid-turn with no error, no timeout of its own and nothing in a log
 * to read. The bound that prevents it is `streamTail() < 0` checked FIRST, and
 * it is not an optimization. Two templates carried the same six-line comment
 * above the same eight lines saying so, which is what a missing front door looks
 * like.
 *
 * `streamTail` and `stream` stay, and stay right, for reading a WHOLE log — a
 * page rendering every line, a reader resuming from an index. This is only the
 * "read me the newest thing" case, which is the one with the trap in it.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import { z } from "zod";

import { agent, tool, type WorkflowDef, workflow } from "../../../index.ts";

export const digest = workflow({
  description: "Research a topic overnight and store the result",
  input: z.object({ topic: z.string() }),
  async run(input) {
    await Promise.resolve();
    return { topic: input.topic, summary: "…" };
  },
});

/** Unchanged from epoch 9: a helper that takes a declaration. */
export function describe(def: WorkflowDef): string {
  return def.description ?? "(undescribed)";
}

/** Unchanged from epoch 9: starting a run needs the DEF, which types the input. */
export const research = tool({
  description: "Kick off overnight research on a topic",
  inputSchema: z.object({ topic: z.string() }),
  execute: async ({ topic }, ctx) => {
    const runId = await ctx.workflows.start(digest, { topic }, { key: ctx.sessionId });
    return `Working on it — run ${runId}.`;
  },
});

/**
 * New at epoch 10, and the whole tool. The chunk is `unknown` — whatever the
 * body handed `getWritable()`, which this SDK does not constrain — so a tool
 * narrating progress says `String(line)` and a body writing structured records
 * narrows with a guard of its own.
 */
export const progress = tool({
  description: "Say where the overnight research has got to",
  inputSchema: z.object({ runId: z.string() }),
  execute: async ({ runId }, ctx) => {
    const line = await ctx.workflows.lastLine(runId);
    return line === undefined
      ? { note: "Started, nothing to report yet." }
      : { progress: String(line) };
  },
});

/**
 * A reader that has already seen up to an index passes it as a FLOOR: nothing
 * resolves until the run has written past it, which is the shape a poll wants.
 */
export const progressSince = tool({
  description: "Say what is new since a line the caller already heard",
  inputSchema: z.object({ runId: z.string(), seen: z.number() }),
  execute: async ({ runId, seen }, ctx) =>
    await ctx.workflows.lastLine(runId, { startIndex: seen }),
});

export default agent({
  name: "Researcher",
  workflows: { digest },
});
