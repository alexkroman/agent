// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:dialog` epoch 3.
 *
 * **Moved for a TRANSITIVE reason.** The export list is identical to epoch 2's
 * and every signature this capability owns is unchanged. What moved is
 * `ToolDef`, which grew a result type parameter at `aai:tool` epoch 10 (see
 * `../tool/v10.ts`); `Dialog.tool` answers a `ToolDef`, so the declaration lands
 * in this capability's report and the hash moved with it. Epoch 2 is RETAINED
 * and `./v2.ts` compiles unchanged beside this file.
 *
 * The interesting part is what did NOT follow. `Dialog.tool` still returns
 * `ToolDef<P>` — `R` is taken by `DialogToolDef` and dropped at the boundary —
 * and that is CORRECT here rather than an oversight waiting to be threaded
 * through. A dialog tool's body returns `R`, but what the runtime hands back is
 * `DialogToolResult<R> | ToolFailure`: the position the conversation landed in,
 * stapled onto the body's own value. Carrying `R` out through the `ToolDef`
 * would make `InferToolOutput<typeof quoteClaim>` resolve to `{ premium: number }`
 * — a shape no client ever receives — which is a worse answer than `unknown`,
 * because it is confidently wrong and would be believed.
 *
 * So the thing an author writes because of this epoch is the wrapper, BY NAME:
 * `DialogToolResult<…>` is what a page renders and what a spec asserts on, and
 * it is public for exactly that.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import { setup } from "xstate";
import { z } from "zod";

import {
  type DialogPosition,
  type DialogToolResult,
  dialog,
  type InferToolOutput,
  toolFailure,
} from "../../../index.ts";

const machine = setup({
  types: {} as { events: { type: "VERIFIED" } | { type: "QUOTED" } },
}).createMachine({
  id: "claim",
  initial: "verifying",
  states: {
    verifying: {
      meta: { instruction: "Get the caller's policy number and verify it." },
      on: { VERIFIED: "quoting" },
    },
    quoting: {
      meta: { instruction: "Read the excess disclosure, then quote." },
      on: { QUOTED: "done" },
    },
    done: { type: "final" },
  },
});

/** Unchanged from epoch 2: a store key, a machine, and nothing else. */
export const claim = dialog("claim", machine);

/**
 * Unchanged from epoch 2, and the declaration `R` is inferred from: `execute`
 * returns `{ premium: number } | ToolFailure`, and `R` is the half that is not
 * the failure. Nothing is sent when it fails — a tool that did not do the thing
 * must not leave the conversation a step ahead of reality.
 */
export const quoteClaim = claim.tool({
  description: "Quote the claim once the policy is verified",
  inputSchema: z.object({ excess: z.number() }),
  when: "quoting",
  send: { type: "QUOTED" },
  execute: ({ excess }) =>
    excess < 0 ? toolFailure("An excess cannot be negative.") : { premium: excess * 2 },
});

/**
 * What a caller actually receives, named at epoch 3: the body's value under
 * `result`, and the position it landed in alongside — which is how a client
 * renders "quoted, and you are now done" from one tool result rather than
 * waiting for a separate state push.
 */
export type QuoteOutcome = DialogToolResult<{ premium: number }>;

export const sampleQuote: QuoteOutcome = {
  state: "done",
  done: true,
  result: { premium: 500 },
};

/**
 * And the corollary, as a compile-checked fact rather than a claim: the tool's
 * declared output is `unknown`. A `string` is assignable here only because of
 * that — with `R` threaded out through the `ToolDef`, this line would be the
 * error that says so, and it would be reporting a shape (`{ premium: number }`)
 * that no caller ever receives. `sampleQuote` above is the honest one.
 */
export const declaredOutput: InferToolOutput<typeof quoteClaim> = "unknown, deliberately";

/** The position on its own, for the projection a page subscribes to. */
export const progress = claim.projection((at: DialogPosition) => ({
  state: at.state,
  done: at.done,
  instruction: at.instruction,
}));
