// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:dialog` epoch 16.
 *
 * A roadside call flow as it was declared at epoch 16 — the whole vocabulary a
 * dialog had then: `instruction` on every state, `on` maps naming the author's
 * own events, a nested pair under `dispatching`, a `final` state, and tools
 * gated with `when` plus the two ways to advance (`send` for a fixed
 * transition, `sendFrom` when the result decides). It must keep compiling for
 * as long as that epoch is advertised as supported.
 *
 * ## What moved, and why epoch 16 survives it
 *
 * Two things, and they are different kinds of change.
 *
 * The capability gained six TYPES — `DialogTimeoutSpec`, `DialogTimeout`,
 * `DialogSessionEventName`, `DialogVoiceConfig`, `DialogBargeIn`, `AnyDialog` —
 * which is pure addition and cannot reach a file that names none of them.
 *
 * The one worth the argument is that {@link Dialog} itself gained three
 * MEMBERS: `receive`, `timeout` and `voiceConfig`. Adding a member to an
 * interface breaks anyone who IMPLEMENTS it, and breaks nobody who only calls
 * it — and nothing outside this package ever implements a `Dialog`, because
 * `dialog()` is the only thing that constructs one. That asymmetry is the whole
 * reason this bump could be `--retain` rather than `--drop`, and it is a
 * property of the design rather than luck: the interface is a HANDLE the
 * factory returns, so its member list is the SDK's to grow.
 *
 * **The directions that WOULD break this file**, which is what freezing it is
 * for: `when` ceasing to accept a bare string (five of the six tools below pass
 * one); `send` and `sendFrom` merging into one field, since `sendFrom`'s
 * parameter is narrowed to the SUCCESS type and a union of an event and a
 * function of one cannot be narrowed by `typeof`; `DialogToolDef.execute`
 * losing its `ToolFailure` return arm, which is what lets {@link quoteFee} fail
 * without the dialog advancing past it; a state's `instruction` becoming
 * required, or `final` ceasing to be spelled `final: true`; and `dialog()`
 * itself demanding the key second, which the argument order deliberately
 * refuses.
 *
 * Note what this file does NOT do, on purpose: it declares no `timeout`, no
 * `@`-prefixed session event and no per-state knob, and it is never handed to
 * `agent({ dialogs })`. That is exactly the shape of a dialog written before
 * any of that existed, which is what epoch 16 means.
 */

import { z } from "zod";
import { dialog, type ToolFailure, tool } from "../../../index.ts";

/** The call, in the six states epoch 16 could describe. */
export const call = dialog("roadside-v16", {
  initial: "locating",
  states: {
    locating: {
      instruction: "Find out where the caller is and what they are driving.",
      on: { LOCATED: "verifying" },
    },
    verifying: {
      instruction: "Look the policy up and read the coverage back before quoting.",
      on: { VERIFIED: "quoting", UNCOVERED: "declined" },
    },
    quoting: {
      instruction: "Quote the call-out fee. Do not dispatch until they accept.",
      on: { ACCEPTED: "dispatching", DECLINED: "declined" },
    },
    dispatching: {
      initial: "assigning",
      states: {
        assigning: {
          instruction: "Assign a truck and give the caller its ETA.",
          on: { ASSIGNED: "confirming" },
        },
        confirming: {
          instruction: "Read the ETA back and confirm the caller will wait with the vehicle.",
          on: { CONFIRMED: "done" },
        },
      },
      on: { CONFIRMED: "done" },
    },
    declined: { instruction: "Explain why, and offer the paid rate.", final: true },
    done: { instruction: "The truck is on its way. Close the call.", final: true },
  },
});

/** A fixed `send`, and a bare-string `when` — the two commonest shapes. */
export const locate = call.tool({
  description: "Record where the caller is",
  inputSchema: z.object({ mileMarker: z.string(), highway: z.string() }),
  when: "locating",
  send: { type: "LOCATED" },
  execute: ({ mileMarker, highway }) => ({ at: `${highway} @ ${mileMarker}` }),
});

/** `sendFrom`, below `execute`, deciding the transition from the RESULT. */
export const verify = call.tool({
  description: "Look up the caller's roadside coverage",
  inputSchema: z.object({ policy: z.string() }),
  when: "verifying",
  execute: ({ policy }) => ({ covered: policy.startsWith("RA-"), policy }),
  sendFrom: (result) => (result.covered ? { type: "VERIFIED" } : { type: "UNCOVERED" }),
});

/**
 * A body that can FAIL, which is the arm that keeps a failed tool from moving
 * the dialog: nothing is sent when `execute` answers a {@link ToolFailure}.
 */
export const quoteFee = call.tool({
  description: "Quote the call-out fee",
  inputSchema: z.object({ miles: z.number() }),
  when: "quoting",
  send: { type: "ACCEPTED" },
  execute: ({ miles }): { fee: number } | ToolFailure =>
    miles > 200 ? { error: "Out of service range — transfer to the regional desk." } : { fee: 89 },
});

/** An array `when`, and a tool that READS without advancing. */
export const recap = call.tool({
  description: "Recap what has been agreed so far",
  when: ["quoting", "dispatching"],
  execute: () => ({ recapped: true }),
});

/** A nested state addressed as `parent.child`. */
export const assignTruck = call.tool({
  description: "Assign the nearest truck",
  inputSchema: z.object({ unit: z.string() }),
  when: "dispatching.assigning",
  send: { type: "ASSIGNED" },
  execute: ({ unit }) => ({ unit, etaMinutes: 35 }),
});

/**
 * An UNGATED tool calling `dialog.send` itself — what that method is public
 * for, and the shape a tool legal in every state has to take, since `when` is
 * required and listing every state is a gate that gates nothing.
 */
export const confirmWait = tool({
  description: "Confirm the caller will wait with the vehicle",
  inputSchema: z.object({}),
  execute: (_args, ctx) => call.send(ctx, { type: "CONFIRMED" }),
});

/** The position, projected to a client — unchanged across the bump. */
export const callProjection = call.projection((at) => ({
  state: at.state,
  instruction: at.instruction ?? "",
}));
