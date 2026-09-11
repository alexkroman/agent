// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:dialog` epoch 2.
 *
 * Epoch 3 changed nothing about declaring a dialog or gating a tool on a
 * state. What moved is `ToolDef`, which gained an optional `messages` field —
 * what the agent says while a tool runs and what it says when it lands — and
 * `DialogToolDef` is that def with a position, so this capability's report
 * moved with it.
 *
 * The promise, then, is that an epoch-2 gated tool still compiles with no
 * `messages` key of its own. That is what `confirmOrder` below is: a `when`,
 * an `inputSchema`, an `execute`, a `sendFrom` declared BELOW `execute` (the
 * ordering `dialog.test-d.ts` pins), and the `onError` epoch 2 added — and
 * nothing about speech.
 *
 * Coverage is per capability over the union of frozen examples, and `v1.ts`
 * already names all fifteen of this one's exports, so this file is about the
 * transition rather than a roll-call. Its specifiers are RELATIVE, so it
 * proves epoch 2's surface compiles rather than the current build's.
 *
 * @module
 */

import { z } from "zod";

import type { DialogSpec } from "../../../index.ts";
import { dialog, toolFailure } from "../../../index.ts";

const checkoutSpec = {
  initial: "confirming",
  states: {
    confirming: {
      instruction: "You have read the order back. Ask for a plain yes or no.",
      on: { CONFIRMED: "done", DECLINED: "done" },
    },
    done: { final: true, instruction: "Thank the caller." },
  },
} as const satisfies DialogSpec;

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
