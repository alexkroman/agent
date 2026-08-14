// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `state` epoch 4.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 *
 * **Nothing was added to this capability's own exports.** The epoch moved
 * transitively, as epoch 3's did: a slot's tools are handed a `ToolContext`,
 * whose `workflows` client gained `streamTail`. What this file asserts is the
 * same composition — a `slot.updateTool` body gets its typed state value AND the
 * widened client, with neither annotation nor cast — over the wider client.
 *
 * Epochs 1 through 3 still compile beside this one, which is the real claim: a
 * slot written before the client widened is unaffected.
 */

import { z } from "zod";

import { sessionSlot } from "../../../index.ts";

type Desk = { pending: string[]; lastSeen: Record<string, number> };

export const deskSlot = sessionSlot<"desk", Desk>("desk", () => ({ pending: [], lastSeen: {} }));

/**
 * A slot tool over the widened client. The state is what makes the tail useful
 * here: a slot remembers where this session got to, so the read asks only for
 * what is past that.
 */
export const catchUp = deskSlot.updateTool({
  description: "Report the lines a run has written since this session last looked.",
  inputSchema: z.object({ runId: z.string() }),
  execute: async (args, desk, ctx) => {
    const seen: number = desk.lastSeen[args.runId] ?? 0;
    const tail: number = await ctx.workflows.streamTail(args.runId);
    if (tail < seen) return { lines: 0, tail };
    desk.lastSeen[args.runId] = tail + 1;
    desk.pending = desk.pending.filter((id) => id !== args.runId);
    return { lines: tail + 1 - seen, tail };
  },
});

/** The projection half is epoch 2's and unchanged. */
export const deskView = deskSlot.projection((desk: Desk) => ({ pending: desk.pending.length }));
