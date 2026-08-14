// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `tool` epoch 3.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 *
 * **Nothing was added to this capability's own exports.** The epoch moved
 * because `ToolContext.workflows` widened: `WorkflowClient` gained `wakeUp` and
 * `stream`, and a tool reaches them through `ctx`. That is worth an example
 * precisely because it is transitive — a change to a type this capability only
 * MENTIONS is the kind that is invisible in this capability's own diff.
 *
 * Epoch 2's example still compiles beside this one, which is the actual claim:
 * a tool written before the client widened is unaffected.
 */

import { z } from "zod";

import { isToolFailure, type ToolContext, tool, toolFailure } from "../../../index.ts";

/** The widened client, reached the way a tool reaches anything: through `ctx`. */
async function latestProgress(ctx: ToolContext, runId: string): Promise<string> {
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
