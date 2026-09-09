import { z } from "zod";
import { deskFlow, IN_BOOKING } from "../desk.ts";
import { hotelSlot } from "../session.ts";
import { note } from "../shared.ts";

/**
 * Their `give_up`, on every task: end the flow without making the booking, or
 * leave a modification unchanged. The right tools for whatever the caller wants
 * instead — a cancellation, a followup, a new booking — are legal at the desk.
 */
export default deskFlow.tool({
  description:
    "End the booking or modification flow without writing anything: the caller no longer wants " +
    "the room, or needs something this flow can't do (cancel, a callback, a different booking). " +
    "The booking, if one was being modified, stays exactly as it was.",
  when: IN_BOOKING,
  inputSchema: z.object({ reason: z.string().max(200).describe("Short explanation") }),
  execute: ({ reason }, ctx) =>
    hotelSlot.update(ctx, (hotel) => {
      const wasModifying = hotel.draft?.mode === "modify";
      hotel.draft = null;
      note(hotel, `Booking flow abandoned: ${reason}`);
      return {
        abandoned: true,
        message: wasModifying
          ? "Booking left unchanged. Nothing was recorded during the modification - don't claim otherwise."
          : "Nothing was booked or recorded - don't claim otherwise. Continue with what the caller actually wants.",
      };
    }),
  send: { type: "ABANDONED" },
});
