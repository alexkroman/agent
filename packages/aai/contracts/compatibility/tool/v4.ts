// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `tool` epoch 4.
 *
 * See `../agent/v1.ts` for what "frozen" obliges and why the imports are
 * relative.
 *
 * **Nothing was added to this capability's own exports.** The epoch moved
 * because `ToolContext.workflows` widened again: `WorkflowClient` gained
 * `streamTail`. Epoch 3's example still compiles beside this one, and the
 * difference between the two is the point — `latestProgress` there reads the
 * stream directly, which type-checks and can hang, and here it asks the tail
 * first.
 */

import { z } from "zod";

import { isToolFailure, type ToolContext, tool, toolFailure } from "../../../index.ts";

/**
 * A bounded read of the run's progress channel, which is the only kind there
 * is: the channel is never closed, so "no chunk available" is indistinguishable
 * from "the next step has not written yet" from the stream alone.
 */
async function latestProgress(ctx: ToolContext, runId: string): Promise<string> {
  if ((await ctx.workflows.streamTail(runId)) < 0) return "nothing yet";
  const stream = await ctx.workflows.stream(runId, { startIndex: -1 });
  for await (const chunk of stream) return String(chunk);
  return "nothing yet";
}

export const chaseRun = tool({
  description: "Report on a durable run, and stop waiting if asked to.",
  inputSchema: z.object({ runId: z.string(), hurry: z.boolean().optional() }),
  async execute(args, ctx) {
    const run = await ctx.workflows.get(args.runId);
    if (!run) return toolFailure(`No run ${args.runId}`);
    if (args.hurry === true) {
      const woken: number = await ctx.workflows.wakeUp(args.runId);
      if (woken === 0) return { note: "already past its wait" };
    }
    return { status: run.status, progress: await latestProgress(ctx, args.runId) };
  },
});

/** The failure shape is epoch 2's and unchanged — asserted by using it. */
export function stillNarrows(value: unknown): boolean {
  return isToolFailure(value);
}
