import { toolFailure } from "@alexkroman1/aai";
import { countWords } from "@alexkroman1/aai/utils";
import { z } from "zod";
import { digitsOf, speakCode, TODAY } from "../records.ts";
import { hotelSlot } from "../session.ts";
import { addTicket } from "../shared.ts";

/**
 * Take a message for someone who may be a guest — their `take_guest_message`.
 *
 * **Whether the recipient is in-house is resolved here and NEVER returned.** The
 * ticket records `delivered` or `undeliverable` for the desk to act on, and the
 * result the model reads carries neither word, so a receptionist taking the
 * message cannot leak a guest's presence however the caller asks. `agent.test.ts`
 * asserts the result for an in-house guest and a stranger are indistinguishable.
 */
export default hotelSlot.updateTool({
  description:
    "Take a message for someone the caller says is staying here. Delivered only if they are in fact a " +
    "guest - the result never tells you whether they are, and you never tell the caller: no confirming or " +
    "denying anyone's presence, no room numbers, no connecting calls. Read name, number and message back first.",
  inputSchema: z.object({
    recipient: z
      .string()
      .min(1)
      .describe("Full name - first AND last; ask for the last name if only a first was given"),
    callerName: z.string().min(1),
    callerPhone: z.string().min(1),
    message: z.string().min(1).max(500).describe("In the caller's words"),
  }),
  execute({ recipient, callerName, callerPhone, message }, hotel) {
    if (countWords(recipient) < 2) {
      return toolFailure(
        `"${recipient}" is only one name - a message needs the recipient's full name to reach the right ` +
          "person. Ask the caller for the last name, then call again.",
      );
    }
    const wanted = recipient.trim().toLowerCase();
    const inHouse = hotel.bookings.find(
      (b) =>
        b.status === "confirmed" &&
        `${b.firstName} ${b.lastName}`.toLowerCase() === wanted &&
        b.checkIn <= TODAY &&
        b.checkOut > TODAY,
    );
    const ticket = addTicket(
      hotel,
      "guest_message",
      "MSG",
      `for ${recipient.trim()} from ${callerName}`,
      {
        // A matched message takes the registered guest's casing so the stored name
        // doesn't depend on how the caller's was heard.
        recipient: inHouse ? `${inHouse.firstName} ${inHouse.lastName}` : recipient.trim(),
        callerName,
        callerPhone: digitsOf(callerPhone) || callerPhone,
        message,
        status: inHouse ? "delivered" : "undeliverable",
      },
    );
    // Deliberately NOT `...ticket.details`: the status stays on the ledger.
    return {
      recorded: true,
      reference: ticket.code,
      spokenReference: speakCode(ticket.code),
      next:
        "Tell the caller it's logged and give the reference. You don't know whether the recipient is staying " +
        "here and never say either way - the general policy IS shareable: messages for in-house guests reach the " +
        "room within about thirty minutes. Promise delivery timing only, never that the person will read or act on it.",
    };
  },
});
