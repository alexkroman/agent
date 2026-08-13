// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `state` epoch 3.
 *
 * See `../agent/v1.ts` for what "frozen" obliges and why the imports are
 * relative.
 *
 * **Nothing was added to this capability's own exports.** The epoch moved
 * transitively: a slot's tools are handed a `ToolContext`, whose `workflows`
 * client gained `wakeUp` and `stream`. So what this file asserts is that the two
 * surfaces compose — a `slot.updateTool` body still gets its typed state value
 * AND the wider client, with neither annotation nor cast.
 *
 * Epochs 1 and 2 still compile beside this one, which is the real claim: a slot
 * written before the client widened is unaffected.
 */

import { z } from "zod";

import { sessionSlot } from "../../../index.ts";

type Desk = { pending: string[]; filed: number };

export const deskSlot = sessionSlot<"desk", Desk>("desk", () => ({ pending: [], filed: 0 }));

/** A slot tool that also reaches the widened client — the composition. */
export const fileNow = deskSlot.updateTool({
  description: "Stop waiting on a run and record it as filed.",
  inputSchema: z.object({ runId: z.string() }),
  execute: async (args, desk, ctx) => {
    const woken: number = await ctx.workflows.wakeUp(args.runId);
    if (woken > 0) {
      desk.pending = desk.pending.filter((id) => id !== args.runId);
      desk.filed += 1;
    }
    return { woken, filed: desk.filed };
  },
});

/** The projection half is epoch 2's and unchanged. */
export const deskView = deskSlot.projection((desk: Desk) => ({ pending: desk.pending.length }));
