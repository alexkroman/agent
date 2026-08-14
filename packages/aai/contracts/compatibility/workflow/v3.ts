// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `workflow` epoch 3.
 *
 * Epoch 3 added the two things a caller can do to a run that is already
 * going — `wakeUp`, which ends a pending `sleep()` early, and `stream`, which
 * reads what the run has WRITTEN rather than what its status says. Everything
 * epochs 1 and 2 could express still compiles (see `./v1.ts` and `./v2.ts`,
 * retained for that reason); this file covers only what epoch 3 added.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import { z } from "zod";

import { type StreamOptions, tool, type WakeUpOptions, workflow } from "../../../index.ts";

export const review = workflow({
  description: "Draft a report, sit on it, then file it.",
  input: z.object({ topic: z.string() }),
  async run(input) {
    await Promise.resolve();
    return { topic: input.topic, filed: true };
  },
});

/** The option bags, named — a caller building one before deciding a target. */
export const everySleep: WakeUpOptions = {};
export const oneSleep: WakeUpOptions = { correlationIds: ["review-delay"] };
export const wholeStream: StreamOptions = {};
export const lastLine: StreamOptions = { startIndex: -1 };
export const namedStream: StreamOptions = { namespace: "progress", startIndex: 0 };

/** Ending the wait early, and reporting the count rather than a boolean. */
export const fileItNow = tool({
  description: "Stop waiting and file the report.",
  inputSchema: z.object({ runId: z.string() }),
  async execute(args, ctx) {
    const woken: number = await ctx.workflows.wakeUp(args.runId);
    const targeted: number = await ctx.workflows.wakeUp(args.runId, oneSleep);
    return { woken, targeted };
  },
});

/** Reading the run's own progress channel. */
export const progress = tool({
  description: "Say what the run is doing right now.",
  inputSchema: z.object({ runId: z.string() }),
  async execute(args, ctx) {
    const stream: ReadableStream<unknown> = await ctx.workflows.stream(args.runId, lastLine);
    for await (const chunk of stream) return { progress: String(chunk) };
    return { progress: "nothing yet" };
  },
});
