// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `workflow` epoch 4.
 *
 * Epoch 4 added `streamTail`, and it is what makes epoch 3's `stream` USABLE
 * rather than a second way of doing the same thing. A workflow stream reports
 * its end only once CLOSED, and a progress channel written by one step after
 * another is never closed — no step knows it is the last one — so epoch 3's
 * `for await (…) return` shape waits forever on a run that has written nothing,
 * a finished run included. A caller bounds itself by the tail instead.
 *
 * Everything epochs 1 through 3 could express still compiles (see `./v1.ts`
 * through `./v3.ts`, retained for that reason), which for epoch 3 is the
 * narrower claim worth stating: those calls still TYPE-CHECK, and the reason
 * this epoch exists is that one of them can hang.
 *
 * See `../agent/v1.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import { z } from "zod";

import { type StreamOptions, tool, workflow } from "../../../index.ts";

export const review = workflow({
  description: "Draft a report, sit on it, then file it.",
  input: z.object({ topic: z.string() }),
  async run(input) {
    await Promise.resolve();
    return { topic: input.topic, filed: true };
  },
});

/** The tail takes the same option bag `stream` does, so one value serves both. */
export const lastLine: StreamOptions = { startIndex: -1 };

/** How far the stream goes — `-1` for a channel nothing has written to. */
export const progress = tool({
  description: "Say what the run is doing right now.",
  inputSchema: z.object({ runId: z.string() }),
  async execute(args, ctx) {
    const tail: number = await ctx.workflows.streamTail(args.runId);
    if (tail < 0) return { progress: "nothing yet" };
    const stream: ReadableStream<unknown> = await ctx.workflows.stream(args.runId, lastLine);
    for await (const chunk of stream) return { progress: String(chunk) };
    return { progress: "nothing yet" };
  },
});

/**
 * The other thing a tail is for: a reader that knows where it got to and wants
 * only what is past that, without re-reading the whole log.
 */
export const resumeFrom = tool({
  description: "Read the lines written since the caller last looked.",
  inputSchema: z.object({ runId: z.string(), seen: z.number() }),
  async execute(args, ctx) {
    const options: StreamOptions = { namespace: "progress", startIndex: args.seen };
    const tail: number = await ctx.workflows.streamTail(args.runId, options);
    const lines: string[] = [];
    if (tail < args.seen) return { lines, tail };
    const stream = await ctx.workflows.stream(args.runId, options);
    const reader = stream.getReader();
    try {
      for (let index = args.seen; index <= tail; index += 1) {
        const { done, value } = await reader.read();
        if (done) break;
        lines.push(String(value));
      }
    } finally {
      reader.releaseLock();
    }
    return { lines, tail };
  },
});
