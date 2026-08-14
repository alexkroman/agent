// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:state` epoch 6.
 *
 * **Epoch 6 is a RIPPLE, not a change to this capability.** `StartOptions`
 * gained `notify` — ask to be told when a run finishes — and this capability's
 * report mentions that type through a public signature, so its hash moved while
 * nothing an author writes here did. `aai:workflow` epoch 6 is where the
 * addition is demonstrated.
 *
 * So this file is epoch 5's example, re-frozen: what it proves is exactly
 * what a re-frozen epoch should prove — that the authoring shape still compiles
 * against current source. See `../agent/v3.ts` for what "frozen" obliges and why
 * the imports are relative.
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
