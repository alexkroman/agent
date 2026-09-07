// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:dialog` epoch 18.
 *
 * A booking conversation as a dialog: a nested spec, a gated tool that advances
 * on a fixed event, and one whose RESULT picks the transition. Written the way
 * it was authored at epoch 18, and it must keep compiling for as long as that
 * epoch is advertised as supported.
 *
 * ## What moved, and why epoch 18 survives it
 *
 * Nothing in this capability's own surface — the export list is unchanged. The
 * report moved for `ToolContext`, which gained `deadlineAt` and which every
 * gated tool's body is handed.
 *
 * The interesting frozen property here is the ORDER of a tool's fields.
 * {@link confirmSeats} declares `sendFrom` BELOW `execute`, because `R` is
 * inferred from the body and `NoInfer` keeps `sendFrom` from bidding on it —
 * so the parameter is the body's own union in that order, and `unknown` in the
 * other. That is a convention the compiler enforces (writing it first gives
 * `TS18046` at the first property read), and it is frozen here so a change to
 * either half fails on this file.
 */

import { z } from "zod";
import {
  type AnyDialog,
  type DialogBargeIn,
  type DialogPosition,
  type DialogSessionEventName,
  type DialogSpec,
  type DialogTimeout,
  type DialogTimeoutSpec,
  type DialogToolResult,
  type DialogVoiceConfig,
  dialog,
  sessionSlot,
  type ToolDef,
} from "../../../index.ts";

const spec = {
  initial: "greeting",
  states: {
    greeting: {
      instruction: "Ask which show they want.",
      on: { CHOSE: "seating" },
    },
    seating: {
      instruction: "Ask how many seats, then confirm.",
      on: { BOOKED: "done", SOLD_OUT: "greeting" },
    },
    done: { instruction: "Say the booking reference.", final: true },
  },
} as const satisfies DialogSpec;

/** The dialog. `AnyDialog` is what an `agent({ dialogs })` array is typed as. */
export const boxOffice = dialog("boxOffice", spec);
export const dialogs: AnyDialog[] = [boxOffice];

/**
 * What a state may declare about the CALL, as opposed to about a tool result.
 *
 * Named through the published types rather than written inline, so the epoch
 * freezes the SHAPES and not merely the spec literal above: a silence deadline
 * that lands somewhere (`DialogTimeout`/`DialogTimeoutSpec`), the session event
 * a state listens for (`DialogSessionEventName`), and the per-state voice knobs
 * (`DialogVoiceConfig`, whose `bargeIn` is a `DialogBargeIn`).
 */
const quietFor: DialogTimeoutSpec = { afterMs: 12_000, send: "SOLD_OUT" };

/** The same deadline as the RUNTIME reports it: the event built, not named. */
export const seatingTimeout: DialogTimeout = {
  afterMs: quietFor.afterMs,
  event: { type: quietFor.send },
};
export const listensFor: DialogSessionEventName = "@user-transcript.committed";
const bargeIn: DialogBargeIn = "off";
export const readBackVoice: DialogVoiceConfig = { bargeIn, temperature: 0.2 };

const seatsSlot = sessionSlot("seats", () => ({ show: null as string | null, held: 0 }));

/** An ungated tool that SPREADS the position it landed in. */
export const chooseShow: ToolDef = seatsSlot.updateTool({
  description: "Record which show the caller wants.",
  inputSchema: z.object({ show: z.string() }),
  execute({ show }, seats, ctx) {
    seats.show = show;
    return { show, ...boxOffice.send(ctx, { type: "CHOSE" }) };
  },
});

/**
 * A gated tool whose RESULT decides the transition.
 *
 * `sendFrom` is written last, and that is load-bearing — see the module doc.
 */
export const confirmSeats: ToolDef = boxOffice.tool({
  description: "Hold seats for the show already chosen.",
  when: "seating",
  inputSchema: z.object({ seats: z.number().int().positive() }),
  execute({ seats }, ctx) {
    const held = seatsSlot.get(ctx).held;
    if (seats + held > 8) {
      return { booked: false as const, reference: undefined, message: "Not that many left." };
    }
    return {
      booked: true as const,
      reference: `BX${1000 + seats}`,
      message: "Read the reference back.",
    };
  },
  sendFrom: (result) => (result.booked ? { type: "BOOKED" } : { type: "SOLD_OUT" }),
});

/** Reading a gated result, which carries the position beside the value. */
export function referenceOf(
  result: DialogToolResult<{ booked: boolean; reference?: string }>,
): string | null {
  return result.result.reference ?? null;
}

/** Where the conversation is, for a tool that only reports. */
export function positionOf(ctx: Parameters<typeof boxOffice.position>[0]): DialogPosition {
  return boxOffice.position(ctx);
}
