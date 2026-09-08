import { isToolFailure, toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { requireRoom } from "../hotel.ts";
import { EMERGENCY_KINDS, type EmergencyKind } from "../records.ts";
import { addTicket, hotelSlot } from "../shared.ts";

/** What the caller is told to do THEMSELVES, per kind — never a substitute for sending hotel people. */
const DIRECTION: Record<EmergencyKind, string> = {
  medical:
    "then have them hang up and dial 9-1-1; the dispatcher stays on the line and coaches them until the " +
    "ambulance arrives. Don't give medical instructions yourself.",
  fire:
    "tell them to get out now via the stairs or fire escapes, NOT the elevator, stay low if there's smoke, " +
    "and once safe call the fire brigade on 9-1-1. Don't tell them to fight the fire or investigate it.",
  security:
    "if they're in any immediate danger tell them to call 9-1-1 now and stay somewhere safe with the door " +
    "locked; otherwise our security and duty manager will be right there. Don't tell them to confront anyone.",
};

/**
 * EMERGENCY ONLY — their `dispatch_emergency`. No verification, no other flow
 * first: it alerts the duty manager and sends hotel staff to the room, which is
 * the PRIMARY action; outside help is the direction given to the caller after.
 */
export default hotelSlot.updateTool({
  description:
    "EMERGENCY ONLY - a real, in-progress danger. Call it the MOMENT you have the room number and what's " +
    "happening: no verification, no other question first. medical = someone hurt, collapsed, unresponsive; " +
    "fire = fire, smoke, alarm; security = intruder, assault, theft. NOT for a noisy neighbour with nobody in " +
    'danger - that is record_followup (kind "other").',
  inputSchema: z.object({
    room: z.string().describe("The room number - get this first"),
    kind: z.enum(EMERGENCY_KINDS),
    situation: z.string().min(1).max(200).describe("One short sentence: what's happening to whom"),
  }),
  execute({ room, kind, situation }, hotel) {
    const found = requireRoom(hotel, room);
    if (isToolFailure(found)) return toolFailure(`${found.error}, calmly, right now`);
    const ticket = addTicket(
      hotel,
      "emergency",
      "EMG",
      `${kind} in room ${found.id}: ${situation}`,
      {
        room: found.id,
        kind,
        situation,
        status: "dispatched",
      },
    );
    return {
      dispatched: true,
      reference: ticket.code,
      room: found.id,
      kind,
      next:
        `Duty manager alerted, staff heading to room ${found.id} now. Tell the caller, short and calm, that our ` +
        `people are on their way up right now - ${DIRECTION[kind]}`,
    };
  },
});
