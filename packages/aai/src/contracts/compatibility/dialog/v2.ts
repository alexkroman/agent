// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:dialog` epoch 2.
 *
 * **Nothing in this capability's own surface changed at epoch 3.** Both of the
 * features that moved its hash moved it as ROLLUP COLLATERAL, and saying so is
 * the point of this header: a capability's report is the whole rollup its
 * entrypoint pulls in, so a foreign declaration landing in that rollup moves
 * the hash while `DialogSpec`, `DialogStateSpec`, `DialogToolDef` and the rest
 * stay byte-identical.
 *
 * The two contributors, because one epoch now covers four features:
 *
 * - **The low-confidence band** — `agent({ lowConfidence })`'s three new types
 *   landed in this rollup as foreign declarations.
 * - **Tool-call speech** — `ToolDef` gained an optional `messages` field, and
 *   `DialogToolDef` is that def with a position, so the report followed.
 *
 * What DID change is on the other side of the low-confidence feature and is
 * invisible from here: a state's `keyterms` used to be accepted and applied by
 * nothing, warned about once per deployed agent. It is live now, pushed to the
 * STT stream at the end of each agent turn. That is a behaviour change under an
 * unchanged declaration — which is exactly why the examples below declare one
 * and assert nothing about what happens to it.
 *
 * So the promise is that every epoch-2 dialog declaration still compiles, with
 * no `messages` key of its own anywhere. If a later epoch drops a spec feature
 * or obliges a new key, this file reddens — the signal to DROP the epoch rather
 * than to edit the example.
 *
 * Both arms are here because the union of the four branches' examples covered
 * two different halves of this capability: a STATE SPEC carrying the voice
 * knobs, and a GATED TOOL carrying `onError` and a `sendFrom`. An epoch-2
 * author wrote both.
 *
 * The 15 names epoch 2 promised are already imported and used by `v1.ts`
 * beside this file, and the gate's coverage rule reads the UNION of a
 * capability's frozen examples; restating them here would be a copy that can
 * drift rather than a second proof. Specifiers are RELATIVE, like every
 * fixture here.
 *
 * @module
 */

import { z } from "zod";
import type { DialogSpec, DialogStateSpec, DialogVoiceConfig } from "../../../index.ts";
import { dialog, toolFailure } from "../../../index.ts";

/**
 * A state that narrows the recognizer's vocabulary for one phase of the call.
 *
 * The declaration an epoch-2 author wrote — and the one whose MEANING epoch 3
 * changed, from "accepted and warned about" to "applied per turn".
 */
const collecting: DialogStateSpec = {
  instruction: "Ask for the order number and read it back.",
  keyterms: ["order number", "gift card"],
  bargeIn: { minWords: 3 },
  temperature: 0.2,
  on: { CONFIRMED: "done" },
} satisfies DialogVoiceConfig & DialogStateSpec;

const callSpec = {
  initial: "collecting",
  states: {
    collecting,
    done: { final: true, instruction: "Thank them and stop." },
  },
} satisfies DialogSpec;

export const callFlow = dialog("call", callSpec);

const checkoutSpec = {
  initial: "confirming",
  states: {
    confirming: {
      instruction: "You have read the order back. Ask for a plain yes or no.",
      on: { CONFIRMED: "done", DECLINED: "done" },
    },
    done: { final: true, instruction: "Thank the caller." },
  },
} satisfies DialogSpec;

export const checkout = dialog("checkout", checkoutSpec, { durable: true });

/**
 * An epoch-2 gated tool: `onError` classifies a throw, and there is no
 * `messages` field for it to decline to set.
 */
export const confirmOrder = checkout.tool({
  description: "Record the caller's yes or no on the order just read back.",
  when: "confirming",
  inputSchema: z.object({ answer: z.enum(["yes", "no"]) }),
  execute: ({ answer }) => ({ confirmed: answer === "yes" }),
  sendFrom: (result) => ({ type: result.confirmed ? "CONFIRMED" : "DECLINED" }),
  onError: () => toolFailure("I couldn't record that just now."),
});
