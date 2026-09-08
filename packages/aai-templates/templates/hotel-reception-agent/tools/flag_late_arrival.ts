import { isToolFailure, toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { hotelSlot, note, requireVerified } from "../shared.ts";

/** Their `flag_late_arrival`: a note on the booking so the desk holds the room. */
export default hotelSlot.updateTool({
  description:
    'Flag the verified booking with an expected late arrival ("checking in around 1 AM", "redeye ' +
    'lands at 11 PM") so the front desk holds the room and does not no-show it. Verify first.',
  inputSchema: z.object({
    note: z.string().max(200).describe("When the caller expects to arrive, concretely"),
  }),
  execute({ note: arrival }, hotel) {
    const booking = requireVerified(hotel);
    if (isToolFailure(booking)) return booking;
    if (booking.status !== "confirmed")
      return toolFailure("that booking is cancelled - nothing to flag");
    booking.lateArrivalNote = arrival;
    note(hotel, `Late arrival on ${booking.code}: ${arrival}`);
    return {
      noted: true,
      code: booking.code,
      message: `Noted on the booking - we'll hold the room. See you ${arrival}.`,
    };
  },
});
