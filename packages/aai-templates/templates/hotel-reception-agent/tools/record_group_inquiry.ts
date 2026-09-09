import { z } from "zod";
import { digitsOf, isoDate, speakCode } from "../records.ts";
import { hotelSlot } from "../session.ts";
import { addTicket } from "../shared.ts";

/** Their `record_group_inquiry`: fifteen or more guests is a block, never a booking. */
export default hotelSlot.updateTool({
  description:
    "Open a room-block inquiry for a group of 15 or more guests. Records it for the group desk - it " +
    "does NOT confirm or hold rooms, and nothing can be confirmed on this call however hard the caller " +
    'pushes; a new sponsor needs credit approval first. Quote terms from lookup_policy "group_bookings". ' +
    "Under 15 guests, use the normal booking flow.",
  inputSchema: z.object({
    company: z.string().min(1),
    contactName: z.string().min(1),
    contactPhone: z.string().min(1),
    partySize: z.number().int().min(15),
    shareType: z
      .enum(["twin", "double", "single", "mixed"])
      .describe("The predominant room-share arrangement"),
    checkIn: isoDate("the arrival date"),
    nights: z.number().int().min(1),
  }),
  execute(args, hotel) {
    const ticket = addTicket(
      hotel,
      "group_inquiry",
      "GRP",
      `${args.company}: ${args.partySize} guests from ${args.checkIn}, ${args.nights} nights`,
      {
        ...args,
        contactPhone: digitsOf(args.contactPhone) || args.contactPhone,
        status: "pending_credit_approval",
      },
    );
    return {
      recorded: true,
      reference: ticket.code,
      spokenReference: speakCode(ticket.code),
      next:
        "Nothing is confirmed yet: tell the caller the group desk will call them back within two business " +
        "days, after credit review, to confirm the block.",
    };
  },
});
