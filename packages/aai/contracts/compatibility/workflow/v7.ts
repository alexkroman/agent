// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `workflow` epoch 7.
 *
 * Epoch 7 adds `WorkflowClient.signal(token, payload?)` — deliver an answer to a
 * run parked on `createHook({ token })`. It is what makes a human-in-the-loop
 * waitpoint reachable from a TOOL: before it, the only way to feed a hook was
 * the public URL `createWebhook()` mints, which is addressed to a third party
 * with a callback to make rather than to the caller already on the line.
 *
 * Epochs 1 through 6 are unchanged and retained, so this file demonstrates only
 * what is new.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import { z } from "zod";

import { tool, workflow } from "../../../index.ts";

export const approve = workflow({
  description: "Do the work, then wait for a person to say whether it stands.",
  input: z.object({ subject: z.string(), requestedBy: z.string() }),
  async run(input) {
    await Promise.resolve();
    return { subject: input.subject, kept: true };
  },
});

/**
 * The token, derived in ONE place.
 *
 * A hook's token is chosen by the body and typed in by the tool, so it is the
 * one string two files must derive identically — and a template literal written
 * twice drifts silently: the body waits on a token nobody signals, and the only
 * symptom is `signal` resolving `false`, which is also the ordinary "nobody is
 * waiting" answer.
 */
export function approvalToken(sessionId: string): string {
  return `approval:${sessionId}`;
}

export const answer_approval = tool({
  description: "Tell the run whether its work stands.",
  inputSchema: z.object({ keep: z.boolean() }),
  async execute(args, ctx) {
    const delivered: boolean = await ctx.workflows.signal(approvalToken(ctx.sessionId), {
      keep: args.keep,
    });
    // `false` is an ANSWER, not a failure — the window closed, the run finished,
    // or it was never started. Same shape as `cancel` resolving false.
    return delivered ? { answered: true, keep: args.keep } : { answered: false };
  },
});

/** The payload is optional: a signal can mean only that something happened. */
export const nudge = tool({
  description: "Tell the run to stop waiting, with nothing to say about it.",
  async execute(_args, ctx) {
    return { woken: await ctx.workflows.signal(approvalToken(ctx.sessionId)) };
  },
});
