// Copyright 2026 the AAI authors. MIT license.
/**
 * Epoch-1 example: `aai:dialog`. A dialog as it was authored before
 * {@link SlotHolder} existed — `position`, `matches`, `send` and `reset` each
 * called with a full {@link ToolContext}.
 *
 * FROZEN, and a PROMISE rather than a decoration: epoch 1 is retained as
 * supported, so `pnpm typecheck` compiling this file is the evidence that a
 * dialog written at that epoch still compiles. An error here IS the finding — do
 * not edit it to follow a change in the API. That is what a new epoch is for.
 *
 * Epoch 2 widened those four to `SlotHolder`, so a session event handler can
 * advance a dialog as well as a tool body. A `ToolContext` satisfies it
 * structurally, which is what every line below is here to demonstrate.
 *
 * The imports are relative source paths for the reason `state/v1.ts` gives.
 */

import { z } from "zod";
import type { DialogPosition, ToolContext } from "../../../index.ts";
import { dialog, tool } from "../../../index.ts";

/** The spec form — `{ initial, states }`, with the event union derived. */
const claim = dialog("claim-v1", {
  initial: "verifying",
  states: {
    verifying: {
      instruction: "Get the caller's policy number and verify it.",
      on: { VERIFIED: "quoting" },
    },
    quoting: {
      instruction: "Read the excess disclosure, then quote.",
      on: { QUOTED: "done", ABANDONED: "verifying" },
    },
    done: { final: true },
  },
});

/** A gated tool: it cannot run before the caller is verified. */
export const quoteClaim = claim.tool({
  description: "Quote the claim once the policy is verified.",
  inputSchema: z.object({ excess: z.number() }),
  when: "quoting",
  send: { type: "QUOTED" },
  execute: (args) => ({ premium: args.excess * 2 }),
});

/** One decided by the RESULT rather than fixed — `sendFrom`, declared last. */
export const abandonClaim = claim.tool({
  description: "Give up on the quote if the caller changes their mind.",
  inputSchema: z.object({ sure: z.boolean() }),
  when: ["quoting", "verifying"],
  execute: (args) => ({ abandoned: args.sure }),
  sendFrom: (result) => (result.abandoned ? { type: "ABANDONED" } : undefined),
});

/**
 * An UNGATED tool driving the dialog itself, which is what the four accessors
 * are public for — and the shape that made them take a context.
 */
export const verifyCaller = tool({
  description: "Verify the caller's policy number.",
  inputSchema: z.object({ policy: z.string() }),
  execute: (args, ctx) => {
    if (!claim.matches(ctx, "verifying")) return { at: claim.position(ctx).state };
    const moved = claim.send(ctx, { type: "VERIFIED" });
    return { at: moved.state, policy: args.policy };
  },
});

/** Reading and restarting, each handed the full tool context epoch 1 required. */
export function exerciseDialog(ctx: ToolContext): DialogPosition {
  const at = claim.position(ctx);
  return at.done ? claim.reset(ctx) : at;
}

/** The projection a client renders the current step from. */
export const claimProjection = claim.projection((at) => ({
  step: at.state,
  hint: at.instruction ?? null,
}));

/** The machine itself stays reachable, for a visualizer or a path enumerator. */
export const claimMachine = claim.machine;
