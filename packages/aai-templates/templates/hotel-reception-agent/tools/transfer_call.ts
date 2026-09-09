import { z } from "zod";
import { TRANSFER_DESTINATIONS } from "../records.ts";
import { hotelSlot } from "../session.ts";
import { addTicket } from "../shared.ts";

/**
 * Transfer the caller to a DEPARTMENT — their `transfer_call`, a stub that
 * records the hand-off. Never a guest's room: connecting a caller to a guest is
 * the thing `guest_privacy` forbids without exception.
 *
 * A transfer happens exactly once per destination. If the model re-calls this
 * (the caller reacts and it "re-confirms"), no second record is written — their
 * deterministic grader counted rows, and a duplicate failed the run.
 */
export default hotelSlot.updateTool({
  description:
    "Transfer the caller to a hotel DEPARTMENT - the restaurant, the duty manager, or housekeeping. " +
    "NOT a guest's room. Before calling: tell the caller you're putting them on hold to connect them " +
    "and get their okay. Pass a one-line summary so the department is briefed.",
  inputSchema: z.object({
    destination: z.enum(TRANSFER_DESTINATIONS),
    summary: z.string().min(1).max(300),
  }),
  execute({ destination, summary }, hotel) {
    const spoken = destination.replaceAll("_", " ");
    if (hotel.transferredTo.includes(destination)) {
      return {
        transferred: true,
        alreadyTransferred: true,
        message: `Already transferred to the ${spoken} on this call - do NOT transfer again. Briefly reassure the caller they're being connected.`,
      };
    }
    hotel.transferredTo.push(destination);
    const ticket = addTicket(hotel, "transfer", "XFR", `to ${spoken}: ${summary}`, {
      destination,
      summary,
    });
    return {
      transferred: true,
      alreadyTransferred: false,
      reference: ticket.code,
      message:
        `Transferred to the ${spoken} - your part of the call is done. Give ONE short closing hand-off ` +
        '("You\'re all set - connecting you now"), not "anything else?". Do NOT transfer again or take the ' +
        "request down as a followup.",
    };
  },
});
