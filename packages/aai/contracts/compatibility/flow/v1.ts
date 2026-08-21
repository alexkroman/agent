// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:flow` epoch 1.
 *
 * Epoch 1 is the primitive arriving. What an author writes at this epoch, and
 * what this file therefore has to keep compiling:
 *
 * - **A flow is declared once, beside the machine**, and the machine is an
 *   ordinary `xstate` machine — the SDK re-exports nothing from it, so an author
 *   imports `setup` themselves and everything XState knows how to do with a
 *   machine still applies to this one.
 * - **A state's `meta.instruction` is the state-addressed prompt.** It becomes
 *   `FlowPosition.instruction` while that state is active, which is what a
 *   refusal quotes and what every flow tool's result carries.
 * - **`when` gates, `send` advances, `sendFrom` lets the RESULT advance.** The
 *   two are separate fields and declaring both is an error.
 * - **A `ToolFailure` from the body does not advance the flow**, so a gated tool
 *   returning one is the ordinary way to say "that did not work, stay here".
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative. Editing this file to make a compile error go away defeats the
 * mechanism — the error IS the finding.
 */

import { setup } from "xstate";
import { z } from "zod";

import { type FlowPosition, flow, toolFailure } from "../../../index.ts";

/**
 * The machine. `meta.instruction` on each state is what the agent is supposed
 * to be doing while it is there.
 */
const machine = setup({
  types: {} as {
    events: { type: "VERIFIED" } | { type: "QUOTED" } | { type: "ABANDONED" };
  },
}).createMachine({
  id: "claim",
  initial: "verifying",
  states: {
    verifying: {
      meta: { instruction: "Get the caller's policy number and verify it." },
      on: { VERIFIED: "quoting", ABANDONED: "closed" },
    },
    quoting: {
      meta: { instruction: "Read the excess disclosure aloud, then give the quote." },
      on: { QUOTED: "settled" },
    },
    settled: { type: "final" },
    closed: { type: "final" },
  },
});

export const claim = flow("claim", machine);

/** A gated tool with a FIXED transition: the common case. */
export const verifyPolicy = claim.tool({
  description: "Verify the caller's policy number.",
  inputSchema: z.object({ policyNumber: z.string() }),
  when: "verifying",
  send: { type: "VERIFIED" },
  execute: ({ policyNumber }) =>
    policyNumber === "" ? toolFailure("I did not catch that policy number.") : { verified: true },
});

/** A gated tool whose RESULT picks the transition. */
export const quoteClaim = claim.tool({
  description: "Quote the claim, once the policy is verified.",
  inputSchema: z.object({ excess: z.number() }),
  when: "quoting",
  sendFrom: (result: { premium: number }) =>
    result.premium > 0 ? ({ type: "QUOTED" } as const) : ({ type: "ABANDONED" } as const),
  execute: ({ excess }) => ({ premium: excess * 2 }),
});

/** A tool legal in either state, advancing nothing. */
export const readBack = claim.tool({
  description: "Read back what has been agreed so far.",
  inputSchema: z.object({}),
  when: ["verifying", "quoting"],
  execute: () => ({ note: "read back" }),
});

/** A domain helper over a position, which is what an author's own code takes. */
export function stepLabel(at: FlowPosition): string {
  return at.done ? "finished" : at.state;
}

/** The projection an agent declares as `syncState`, so a page can render the step. */
export const claimProjection = claim.projection((at) => ({
  step: stepLabel(at),
  instruction: at.instruction ?? "",
}));
