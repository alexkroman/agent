// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:dialog` epoch 1.
 *
 * Epoch 2 gave `DialogToolDef` an optional `onError`, the per-tool classifier
 * that turns a THROW inside a gated tool into a `ToolFailure` the model may
 * recover from. Every other way of declaring a dialog tool is untouched, and
 * that is what this file pins: `confirmOrder` below declares `when`, a schema,
 * a body that returns its own `ToolFailure`, and a `sendFrom` that moves the
 * conversation — and no `onError` key at all. A required classifier would have
 * broken every dialog tool ever written; an optional one breaks none.
 *
 * The DECLARED form is pinned alongside it, because that is what an author
 * spends their time in: `checkoutSpec` is a `DialogSpec` with the six features
 * a persisted snapshot allows — `initial`, nested `states`, `instruction`,
 * `on`, `final`, plus a state's own `timeout` — and the per-state voice knobs
 * (`bargeIn`, `keyterms`, `temperature`, `toolChoice`, `voice`) an epoch-1
 * author could already set.
 *
 * That is the whole promise — one optional field on the tool def. If a later
 * epoch obliges a dialog tool to classify its own throws, or drops one of the
 * spec features above, this file reddens, which is the signal to DROP the
 * epoch rather than to edit the example.
 *
 * ## Two things about its SHAPE, both imposed rather than chosen
 *
 * **It names every one of epoch 1's 15 exports.** The gate requires it
 * (`api-contracts-gate.test.ts`) and the reason is worth understanding: a
 * fixture that names one signature freezes one signature, while every other
 * name in the epoch compiles because nothing mentions it. So the back half of
 * this file is a roll-call, and the front half is the part written to be read.
 *
 * **Its specifiers are RELATIVE.** The same gate insists, and rightly:
 * importing the package by name would resolve through its own `exports` map to
 * whatever the current build publishes, so the fixture would prove the CURRENT
 * surface compiles rather than that epoch 1's does.
 *
 * @module
 */

import { z } from "zod";

import type {
  AnyDialog,
  Dialog,
  DialogBargeIn,
  DialogEvent,
  DialogOptions,
  DialogPosition,
  DialogSessionEventName,
  DialogSpec,
  DialogStateSpec,
  DialogTimeout,
  DialogTimeoutSpec,
  DialogToolDef,
  DialogToolResult,
  DialogVoiceConfig,
  SlotHolder,
  ToolFailure,
} from "../../../index.ts";
import { dialog, toolFailure } from "../../../index.ts";

/**
 * The declared form: `{ initial, states }`, and nothing a `structuredClone` of
 * the snapshot could not survive.
 */
const checkoutSpec = {
  initial: "greeting",
  states: {
    greeting: {
      instruction: "Ask which order the caller is phoning about, then read it back.",
      on: { IDENTIFIED: "confirming" },
    },
    confirming: {
      instruction: "You have read the order back. Ask for a plain yes or no.",
      // The per-state voice knobs an epoch-1 author could already set.
      bargeIn: { minWords: 2, minDurationMs: 400 },
      keyterms: ["cancel", "confirm"],
      temperature: 0.2,
      toolChoice: "required",
      voice: "michael",
      // A state's own deadline, and the wire event that also leaves it.
      timeout: { afterMs: 20_000, send: "GAVE_UP" },
      on: { CONFIRMED: "done", GAVE_UP: "greeting", "@session.timed-out": "done" },
    },
    done: {
      final: true,
      instruction: "Thank the caller. There is nothing further to do.",
    },
  },
} as const satisfies DialogSpec;

/** Durable, so the position outlives a reconnect. */
const checkoutOptions: DialogOptions = { durable: true };

export const checkout = dialog("checkout", checkoutSpec, checkoutOptions);

/** The alphabet the spec's `on` maps already spell — never restated beside it. */
export type CheckoutEvent = DialogEvent<typeof checkoutSpec>;

const confirmSchema = z.object({ answer: z.enum(["yes", "no"]) });

/**
 * An epoch-1 dialog tool: gated by `when`, moved by `sendFrom`, and doing its
 * own refusal inside the body. No `onError`.
 */
export const confirmOrder = checkout.tool({
  description: "Record the caller's yes or no on the order just read back.",
  when: "confirming",
  inputSchema: confirmSchema,
  execute({ answer }, ctx): { confirmed: boolean } | ToolFailure {
    if (ctx.messages.length === 0) return toolFailure("Nothing has been said yet.");
    return { confirmed: answer === "yes" };
  },
  // Below `execute`, which is where a `sendFrom` has to sit for its parameter
  // to infer from the body's return rather than from nothing.
  sendFrom: (result) => (result.confirmed ? ({ type: "CONFIRMED" } as const) : undefined),
});

/** Where the conversation is, read the way a projection or a tool reads it. */
export function stageLabel(holder: SlotHolder): string {
  const at: DialogPosition = checkout.position(holder);
  return at.done ? "finished" : `at ${at.state}`;
}

// ── The rest of epoch 1's promised surface.
//
//    The example above pins the SHAPES the transition touched; these are the
//    names it promised and did not reach. Named here because a retained epoch
//    is a promise about all of it, and a fixture that names one signature
//    freezes one signature (`api-contracts-gate.test.ts`).

/** The `@`-prefixed half of an `on` map: the wire's own event names. */
export const onTimedOut: DialogSessionEventName = "@session.timed-out";

export type Epoch1Types = {
  anyDialog: AnyDialog;
  dialogHandle: Dialog<typeof checkout.machine, CheckoutEvent>;
  dialogBargeIn: DialogBargeIn;
  dialogEvent: CheckoutEvent;
  dialogOptions: DialogOptions;
  dialogPosition: DialogPosition;
  dialogSessionEventName: DialogSessionEventName;
  dialogSpec: DialogSpec;
  dialogStateSpec: DialogStateSpec;
  dialogTimeout: DialogTimeout;
  dialogTimeoutSpec: DialogTimeoutSpec;
  dialogToolDef: DialogToolDef<typeof confirmSchema, { confirmed: boolean }, CheckoutEvent>;
  dialogToolResult: DialogToolResult<{ confirmed: boolean }>;
  dialogVoiceConfig: DialogVoiceConfig;
};

export const epoch1Values = [dialog] as const;
