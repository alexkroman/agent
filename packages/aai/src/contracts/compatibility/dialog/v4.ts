// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:dialog` epoch 4.
 *
 * ## Epoch 5 is COLLATERAL: one more name in the event vocabulary a dialog listens to
 *
 * A dialog state's `on` map may be keyed by a session event, spelled
 * `"@<event>"` — `DialogSessionEventName` is `` `@${SessionEventType}` `` — and
 * epoch 5 is `SessionEventType` gaining `"user-turn.exceeded"`, the event
 * `AgentDef.userTurnLimit` leaves behind when it cuts a caller's turn. Nothing
 * else in this capability moved: not `dialog()`, not the spec shape, not the
 * tool envelope. A union member was added to a type this surface reaches, so
 * every `"@…"` key an epoch-4 author wrote is still a legal key, and this file
 * — which writes one — is the evidence. It is the FIRST retained epoch of this
 * capability, so it has to name all fifteen of epoch 4's exports; the back half
 * is that roll-call, and the spec at the top is the part written to be read.
 *
 * If a later epoch removes an event name a dialog listens on, changes what
 * `dialog()` returns, or makes a spec field required, this file reddens — the
 * signal to DROP the epoch rather than to edit the example.
 *
 * Relative specifiers, as every frozen example: the package's own `exports`
 * map would resolve to the CURRENT build, which is the wrong thing to prove.
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
} from "../../../index.ts";
import { agent, dialog } from "../../../index.ts";

/** A caller who has gone quiet is nudged once, on the dialog's own deadline. */
const QUIET_NUDGE: DialogTimeoutSpec = { afterMs: 12_000, send: "QUIET" };

/** A disclosure the caller has to hear whole. */
const UNINTERRUPTIBLE: DialogBargeIn = "off";

/**
 * The session event this dialog listens on, named as the type spells it. An
 * epoch-4 vocabulary name; epoch 5 adds `"@user-turn.exceeded"` beside it.
 */
const TIMED_OUT: DialogSessionEventName = "@session.timed-out";

/** The call, as a spec: three phases and the two ways it ends. */
const BOOKING_SPEC = {
  initial: "greeting",
  states: {
    greeting: {
      instruction: "Find out who is calling and what they want to book. Then call name_caller.",
      bargeIn: { minWords: 1 },
      timeout: QUIET_NUDGE,
      on: { "@session.timed-out": "abandoned", QUIET: "greeting", NAMED: "confirming" },
    },
    confirming: {
      instruction: "Read the booking back in full, then call confirm_booking with their answer.",
      bargeIn: UNINTERRUPTIBLE,
      temperature: 0.2,
      toolChoice: "required",
      on: { "@session.timed-out": "abandoned", CONFIRMED: "done" },
    },
    done: { final: true, instruction: "The booking is made. Say goodbye." },
    abandoned: { final: true, instruction: "The caller is gone. Do nothing further." },
  },
} as const satisfies DialogSpec;

/** Every event the spec can be SENT — the `@…` keys are excluded by construction. */
type BookingEvent = DialogEvent<typeof BOOKING_SPEC>;

const OPTIONS: DialogOptions = { durable: false };

export const booking = dialog("booking", BOOKING_SPEC, OPTIONS);

/** A tool the dialog gates to one phase and moves on the result of. */
const confirmDef: DialogToolDef<
  z.ZodObject<{ accepted: z.ZodBoolean }>,
  { accepted: boolean },
  BookingEvent
> = {
  description: "Record whether the caller accepted the booking as read back.",
  when: "confirming",
  inputSchema: z.object({ accepted: z.boolean() }),
  sendFrom: (result) => (result.accepted ? { type: "CONFIRMED" } : undefined),
  execute: ({ accepted }) => ({ accepted }),
};

export const confirmBooking = booking.tool(confirmDef);

/** What `agent({ dialogs })` is handed — typed to the erased shape a list of dialogs has. */
export const DIALOGS: readonly AnyDialog[] = [booking];

export const desk = agent({
  name: "Bookings",
  greeting: "Bookings, how can I help?",
  dialogs: DIALOGS,
});

// ─── The rest of epoch 4's roll-call ────────────────────────────────────────

type SlotHolder = Parameters<AnyDialog["position"]>[0];

/** Where a call is, read the way a spec or a projection reads it. */
export function positionOf(d: AnyDialog, ctx: SlotHolder): DialogPosition {
  return d.position(ctx);
}

/** The armed deadline, if the current state declares one. */
export function deadlineOf(
  d: Dialog<AnyDialog["machine"], BookingEvent>,
  ctx: SlotHolder,
): DialogTimeout | undefined {
  return d.timeout(ctx);
}

/** The per-state voice knobs the pipeline transport reads. */
export function voiceOf(d: AnyDialog, ctx: SlotHolder): DialogVoiceConfig | undefined {
  return d.voiceConfig(ctx);
}

/** A state spec is addressable on its own — what a shared phase is written as. */
export const GREETING: DialogStateSpec = BOOKING_SPEC.states.greeting;

/** The envelope a dialog tool answers with: the result plus where the call now is. */
export const confirmed: DialogToolResult<{ accepted: boolean }> = {
  state: "done",
  done: true,
  result: { accepted: true },
};

/** An event sent from code rather than from a tool result. */
export const named: BookingEvent = { type: "NAMED" };

export const listensOn: readonly DialogSessionEventName[] = [TIMED_OUT];
