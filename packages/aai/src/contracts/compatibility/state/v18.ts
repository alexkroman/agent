// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:state` epoch 18.
 *
 * The `shared.ts` of a bike-hire desk: one slot with declared growth caps, the
 * two tool builders that read and write it, and the projection both ends render
 * it through. Written the way it was authored at epoch 18, and it must keep
 * compiling for as long as that epoch is advertised as supported.
 *
 * ## What moved, and why epoch 18 survives it
 *
 * Nothing in this capability's own surface: its export list is byte-identical
 * across the bump. The report moved for a type it REACHES — `ToolContext`,
 * which gained a `deadlineAt` field. A rollup follows every type a signature
 * touches, and `slot.tool`/`slot.updateTool` hand their bodies a context, so
 * the tool-authoring type lands in this report whether or not this capability
 * says anything about it.
 *
 * Additive for everything here: a slot's tool bodies READ the context, and a
 * field they do not name cannot break them. {@link quoteHire} takes the context
 * and reads `env` off it without ever mentioning the new field, which is the
 * shape every epoch-18 slot tool has.
 */

import { z } from "zod";
import {
  type DeepReadonly,
  type SessionSlot,
  type SessionSlotOptions,
  type SlotCaps,
  type StateProjection,
  sessionSlot,
  type ToolDef,
} from "../../../index.ts";

interface Hire {
  bike: string;
  hours: number;
}

interface Desk {
  rider: string | null;
  hires: Hire[];
  log: string[];
}

/** The caps, named through their own type so the surface is frozen too. */
const caps: SlotCaps<Desk> = { log: 40, hires: 12 };

const options: SessionSlotOptions<Desk> = {
  caps,
  // A derived field, recomputed after every write.
  after: (desk) => {
    desk.rider = desk.rider?.trim() || null;
  },
};

/** The slot. `hires` and `log` are append-only, and the slot bounds both. */
export const deskSlot: SessionSlot<"desk", Desk> = sessionSlot(
  "desk",
  (): Desk => ({ rider: null, hires: [], log: [] }),
  options,
);

/** The frozen value a READ hands out — the alias every helper here takes. */
export type FrozenDesk = DeepReadonly<Desk>;

/** A WRITE. The body is synchronous, which `updateTool` requires. */
export const startHire: ToolDef = deskSlot.updateTool({
  description: "Start a hire for the rider on the line.",
  inputSchema: z.object({ bike: z.string(), hours: z.number().int().positive() }),
  execute({ bike, hours }, desk) {
    desk.hires.push({ bike, hours });
    desk.log.push(`Hired ${bike} for ${hours}h`);
    return { hires: desk.hires.length };
  },
});

/** A READ, whose body takes the context and never names `deadlineAt`. */
export const quoteHire: ToolDef = deskSlot.tool({
  description: "Quote a hire, at the rate this desk is configured with.",
  inputSchema: z.object({ hours: z.number().int().positive() }),
  execute({ hours }, desk, ctx) {
    const rate = Number(ctx.env.HOURLY_PENCE ?? "450");
    return { pence: rate * hours, openHires: desk.hires.length, rider: desk.rider };
  },
});

/** What the browser is sent — narrowed, so the log does not cross the wire. */
export function deskView(desk: FrozenDesk): { rider: string | null; open: number } {
  return { rider: desk.rider, open: desk.hires.length };
}

/** The projection BOTH ends use. */
export const deskProjection: StateProjection<{ rider: string | null; open: number }> =
  deskSlot.projection(deskView);
