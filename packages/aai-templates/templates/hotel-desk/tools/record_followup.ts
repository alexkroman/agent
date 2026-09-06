import { z } from "zod";
import { digitsOf, FOLLOWUP_KINDS, speakCode } from "../records.ts";
import { addTicket, hotelSlot } from "../shared.ts";

/**
 * Capture something for a human to follow up on — their `record_followup`, the
 * one tool their session declared on the SESSION so every task could reach it:
 * a caller can abandon anywhere, and the alternative to recording the callback
 * where they say so is promising one that was never written.
 *
 * The result's `next` is deliberate: their return ended with "read it back so
 * the caller knows it's actually on the list", because "logged" alone is the
 * sentence a model says whether or not anything was.
 */
export default hotelSlot.updateTool({
  description:
    "Record a request for a human to follow up: housekeeping (in-house guest needs something " +
    "brought or fixed), sales_lead (events, weddings, corporate rates), identity_change (email, " +
    "phone or name on a booking), callback, verification_help (verification failed three times), " +
    "early_checkout, abandoned_booking (dropped mid-booking, wants to finish later), lost_and_found, " +
    'or other. ALWAYS call this instead of saying "someone will follow up" - an unrecorded request vanishes.',
  inputSchema: z.object({
    kind: z.enum(FOLLOWUP_KINDS),
    callerName: z.string().min(1).describe("The caller's real name - ask; never a placeholder"),
    callerPhone: z
      .string()
      .min(1)
      .describe("Callback number - for an in-house guest, the room number works"),
    summary: z.string().min(1).max(400).describe("One sentence a human can act on"),
  }),
  execute({ kind, callerName, callerPhone, summary }, hotel) {
    const contact = digitsOf(callerPhone) || callerPhone;
    const ticket = addTicket(hotel, "followup", "FUP", `${kind}: ${summary}`, {
      kind,
      callerName,
      callerPhone: contact,
      summary,
      status: "open",
    });
    return {
      recorded: true,
      reference: ticket.code,
      spokenReference: speakCode(ticket.code),
      next:
        `Read it back so the caller knows it's actually on the list: who it's for (${callerName}, ` +
        `${contact}) and what's noted ("${summary}"). Don't just say "logged", and don't promise anyone ` +
        "will call back unless that's what was recorded. A followup is a recorded request, not a dispatch.",
    };
  },
});
