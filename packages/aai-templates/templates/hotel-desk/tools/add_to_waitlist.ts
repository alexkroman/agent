import { toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { isIsoDate, MAX_PARTY_SIZE, speakCode, spokenDate } from "../records.ts";
import { addTicket, hotelSlot } from "../shared.ts";

/** Their `add_to_waitlist`: for dates the hotel is sold out on. Holds nothing. */
export default hotelSlot.updateTool({
  description:
    "Put the caller on the waitlist for dates the hotel is SOLD OUT on - only after " +
    "check_room_availability came back empty and they want to be told if something opens up. " +
    "Holds and promises nothing; the desk calls only if a room frees up.",
  inputSchema: z.object({
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    phone: z.string().min(1),
    checkIn: z.string(),
    checkOut: z.string(),
    guests: z.number().int().min(1).max(MAX_PARTY_SIZE),
  }),
  execute(args, hotel) {
    if (!(isIsoDate(args.checkIn) && isIsoDate(args.checkOut)) || args.checkOut <= args.checkIn) {
      return toolFailure("dates must be YYYY-MM-DD with check-out after check-in");
    }
    const ticket = addTicket(
      hotel,
      "waitlist",
      "WL",
      `${args.firstName} ${args.lastName}, ${args.checkIn} to ${args.checkOut}, ${args.guests} guests`,
      { ...args },
    );
    return {
      waitlisted: true,
      reference: ticket.code,
      spokenReference: speakCode(ticket.code),
      dates: `${spokenDate(args.checkIn)} to ${spokenDate(args.checkOut)}`,
      message:
        "Tell the caller they're on the list for those dates and you'll reach out if something opens up - " +
        "make clear nothing is held and it's not a guarantee.",
    };
  },
});
