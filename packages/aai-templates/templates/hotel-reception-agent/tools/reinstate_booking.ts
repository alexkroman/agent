import { isToolFailure, toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { reinstateBooking } from "../hotel.ts";
import { normalizeCode, speakCode, speakUsd, spokenDate, TODAY } from "../records.ts";
import { hotelSlot } from "../session.ts";

/**
 * Bring back a cancelled booking — their `reinstate_booking`, the one flow that
 * verifies against a CANCELLED record, which is why it takes the last name and
 * code itself rather than going through `verify_booking`. If the room has been
 * taken since, say so honestly and offer a new booking; never silently rebook a
 * different room and call it reinstated.
 */
export default hotelSlot.updateTool({
  description:
    "Reactivate a room booking the caller previously CANCELLED. Takes last name plus the " +
    "confirmation code (this is the one lookup that accepts a cancelled booking), checks the " +
    "original room is still free for its dates, and flips it back to confirmed. Not for editing " +
    "a live booking or making a new one.",
  inputSchema: z.object({
    lastName: z.string().min(1),
    confirmationCode: z.string().min(1),
  }),
  execute({ lastName, confirmationCode }, hotel) {
    const code = normalizeCode(confirmationCode);
    const booking = hotel.bookings.find(
      (b) =>
        b.lastName.toLowerCase() === lastName.trim().toLowerCase() &&
        normalizeCode(b.code) === code,
    );
    if (booking === undefined)
      return toolFailure(
        "No booking under that last name and code. Ask the caller to repeat the code.",
      );
    if (booking.status === "confirmed") {
      return {
        reinstated: false,
        message: `That booking, ${speakCode(booking.code)}, is already active - nothing to reinstate. Reassure the caller it's all set.`,
      };
    }
    if (booking.checkIn < TODAY) {
      return toolFailure(
        "that stay's dates have already passed, so it can't be reinstated - offer a new booking",
      );
    }
    const result = reinstateBooking(hotel, booking.code);
    if (isToolFailure(result)) {
      return toolFailure(
        "that room has been taken for those dates since the cancellation - tell the caller honestly and " +
          "offer to check other rooms or dates (start_room_booking); do NOT claim it was reinstated",
      );
    }
    hotel.verifiedCode = result.code;
    return {
      reinstated: true,
      code: result.code,
      spokenCode: speakCode(result.code),
      checkIn: spokenDate(result.checkIn),
      checkOut: spokenDate(result.checkOut),
      total: speakUsd(result.total),
      cardLast4: result.cardLast4,
      message: `Reinstated. Booking ${speakCode(result.code)} is active again - relay the dates and total and move on.`,
    };
  },
});
