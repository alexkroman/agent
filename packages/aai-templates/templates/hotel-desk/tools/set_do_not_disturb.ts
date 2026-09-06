import { toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { requireRoom } from "../hotel.ts";
import { speakCode } from "../records.ts";
import { addTicket, hotelSlot } from "../shared.ts";

/** Their `set_do_not_disturb`: a standing hold on a room's calls and messages. */
export default hotelSlot.updateTool({
  description:
    "Place a Do-Not-Disturb hold on an in-house guest's room - their calls and messages are held until " +
    "they lift it. A standing hold, not a one-off. Always tell the guest a genuine emergency still gets through.",
  inputSchema: z.object({ room: z.string() }),
  execute({ room }, hotel) {
    const found = requireRoom(hotel, room);
    if ("error" in found) return toolFailure(found.error);
    const ticket = addTicket(hotel, "do_not_disturb", "DND", `room ${found.id}`, {
      room: found.id,
      status: "active",
    });
    return {
      set: true,
      room: found.id,
      reference: ticket.code,
      spokenReference: speakCode(ticket.code),
      next: "Confirm it holds their calls and messages until they ask to lift it, and that a genuine emergency still gets through.",
    };
  },
});
