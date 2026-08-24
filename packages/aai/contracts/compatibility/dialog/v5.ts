// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:dialog` epoch 5.
 *
 * **Moved for a TRANSITIVE reason, and nothing a dialog writes changed.**
 * `ToolContext` gained `delegate` (`aai:subagent`), and a `Dialog.tool`'s
 * `execute` receives one — so the declaration lands in this capability's
 * report and the hash moved with it. Epoch 4 is RETAINED and `./v4.ts`
 * compiles unchanged beside this file; the whole example below is epoch 4's,
 * spelling for spelling.
 *
 * What it means for an author is that a GATED tool may now delegate: the
 * refusal a caller gets out of state is unchanged, and inside the state the
 * body has a second tool loop available to it.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */
import { setup } from "xstate";
import { z } from "zod";

import {
  type DialogEvent,
  type DialogPosition,
  type DialogSpec,
  type DialogToolResult,
  dialog,
  type InferToolOutput,
  toolFailure,
} from "../../../index.ts";

/**
 * The declared form. `as const satisfies DialogSpec` is what an author writes:
 * `satisfies` checks the shape, and `as const` is what keeps the transition
 * targets literal so the event union can be read off them.
 */
const claimSpec = {
  initial: "verifying",
  states: {
    verifying: {
      instruction: "Get the caller's policy number and verify it before quoting.",
      on: { VERIFIED: "quoting", ABANDON: "closed" },
    },
    quoting: {
      instruction: "Quote the claim, then confirm the excess.",
      on: { QUOTED: "settled" },
    },
    settled: { final: true },
    closed: { final: true },
  },
} as const satisfies DialogSpec;

export const claim = dialog("claim", claimSpec, { durable: true });

/** Derived from the `on` keys — nothing restates the union. */
export type ClaimEvent = DialogEvent<typeof claimSpec>;
export const verified: ClaimEvent = { type: "VERIFIED" };

/**
 * A gated tool. `when` is the state it may run in; the refusal a caller gets out
 * of state carries the `instruction` above, which is the whole reason the field
 * is declared rather than stuffed into an untyped `meta`.
 */
export const quoteClaim = claim.tool({
  description: "Quote the claim once the policy is verified",
  inputSchema: z.object({ excess: z.number() }),
  when: "quoting",
  execute: ({ excess }) =>
    excess < 0
      ? toolFailure("Excess cannot be negative.")
      : {
          premium: excess * 2,
        },
  sendFrom: (result) => (result.premium > 0 ? ({ type: "QUOTED" } as const) : undefined),
});

/**
 * What epoch 4 makes writable, and epoch 3 could not: the tool's declared output
 * is the envelope the caller really receives, so a page and a spec annotate
 * against `InferToolOutput` instead of restating the wrapper by hand.
 */
export type QuoteOutcome = InferToolOutput<typeof quoteClaim>;

export const sampleQuote: DialogToolResult<{ premium: number }> = {
  state: "settled",
  done: true,
  result: { premium: 500 },
};

/** And the refusal arm is in the type, which is what makes the narrowing honest. */
export function premiumOrReason(outcome: QuoteOutcome): string {
  return "error" in outcome ? outcome.error : String(outcome.result.premium);
}

/** The position on its own, for the projection a page subscribes to. */
export const progress = claim.projection((at: DialogPosition) => ({
  state: at.state,
  done: at.done,
  instruction: at.instruction,
}));

/**
 * The machine overload, unchanged. It is what `procedure()`-shaped work needs
 * and what a dialog reaches for the moment it wants anything the spec form
 * deliberately cannot express.
 */
export const escalation = dialog(
  "escalation",
  setup({ types: {} as { events: { type: "ESCALATED" } } }).createMachine({
    id: "escalation",
    initial: "open",
    states: { open: { on: { ESCALATED: "raised" } }, raised: { type: "final" } },
  }),
);
