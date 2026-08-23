// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:dialog` epoch 4.
 *
 * **Epoch 3 is DROPPED, and its own text is why.** That example asserted, as a
 * compile-checked fact, that `InferToolOutput` on a dialog tool was `unknown` —
 * and argued the erasure was CORRECT, because threading `R` out would resolve to
 * `{ premium: number }`, "a shape no client ever receives". The objection was
 * right about the shape and wrong about the fix. `Dialog.tool` now answers
 * `ToolDef<P, Promise<DialogToolResult<R> | ToolFailure>>`: the full envelope,
 * position and refusal arm included, which IS what the caller receives. So the
 * assertion is the error epoch 3 predicted, and there is no edit that keeps its
 * claim; `contracts.json` carries the record.
 *
 * **Epoch 4 also adds the DECLARED form.** `dialog(key, { initial, states })`
 * takes a plain state map — `instruction`, `on`, `final`, `initial` and nested
 * `states` — and synthesizes the event union from the `on` keys at every depth,
 * so `DialogEvent<typeof spec>` is derived rather than restated. The six
 * features are not a convenience subset: a dialog's snapshot is PERSISTED and
 * must survive `structuredClone`, which rules out guards, context, actions and
 * invoked actors by construction. What an author was paying full XState for was
 * a `setup({ types: {} as { events: … } })` block naming events already written
 * in the `on` maps, plus a `meta: { instruction }` wrapper per state — and
 * `meta` is untyped, so a misspelled `instructions` compiled, deployed, and
 * produced refusals carrying no recovery text.
 *
 * The machine overload stays, because `procedure()` needs full XState and an
 * escape hatch nobody documents is not one. A spec compiles to an ORDINARY
 * machine, so a `durable: true` dialog resumes across an author's switch between
 * the two forms.
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
