// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:tool` epoch 5.
 *
 * **Epoch 5 is a RIPPLE, not a change to this capability.** `WorkflowDef`
 * gained an optional `uploads` list — the property names that carry an upload id
 * rather than a value — and this capability's report mentions that type through
 * a public signature, so its hash moved while nothing an author writes here did.
 * `aai:workflow` epoch 5 is where that addition is demonstrated.
 *
 * So this file is epoch 4's example, re-frozen: what it proves is exactly
 * what a re-frozen epoch should prove — that the authoring shape still compiles
 * against current source. See `../agent/v1.ts` for what "frozen" obliges and why
 * the imports are relative.
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
