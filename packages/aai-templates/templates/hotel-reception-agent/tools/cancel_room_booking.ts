import { isToolFailure, toolFailure } from "@alexkroman1/aai";
import { cancelBooking } from "../hotel.ts";
import { daysBetween, PRICING, speakUsd, TODAY } from "../records.ts";
import { callerTurns, hotelSlot, requireVerified } from "../shared.ts";

/**
 * Cancel the verified booking and say what comes back — their
 * `cancel_room_booking`.
 *
 * **The forfeit is one night at the rate the booking holds**, decided here and
 * handed to the model as a sentence: inside the window one room-night is kept,
 * outside it the refund is the whole total. The model never computes either.
 *
 * **Idempotent on the caller's turn count.** After a cancellation the model
 * sometimes re-invokes this with no new caller input; re-verifying then finds
 * the booking cancelled and dead-ends in "did you mean a different reservation"
 * while the refund answer it already produced never gets relayed. If a cancel
 * just happened and the caller has not spoken since, the outcome is re-surfaced
 * instead. A genuine second cancellation always has a caller turn first.
 */
export default hotelSlot.updateTool({
  description:
    "Cancel the verified caller's room booking - including when they pivot mid-modification " +
    "(abandon_booking first). Returns the refund outcome: relay it exactly, never guess a refund " +
    'or a "deposit". If the caller asks whether they lose money by cancelling, this result IS the answer.',
  execute(_args, hotel, ctx) {
    const turns = callerTurns(ctx.messages);
    if (hotel.lastCancel !== null && turns <= hotel.lastCancel.callerTurns) {
      return {
        alreadyCancelled: true,
        message:
          "You already cancelled this booking moments ago - do NOT cancel again or re-verify. Relay " +
          `the outcome and answer any refund question from it: ${hotel.lastCancel.message}`,
      };
    }
    const booking = requireVerified(hotel);
    if (isToolFailure(booking)) return booking;
    if (booking.checkIn < TODAY)
      return toolFailure("this booking's check-in has already passed; can't cancel a past stay");
    const room = hotel.rooms.find((r) => r.id === booking.roomId);
    const within = daysBetween(TODAY, booking.checkIn) * 24 < PRICING.cancellationWindowHours;
    const forfeit = within ? (room?.nightlyRate ?? 0) : 0;
    const cancelled = cancelBooking(hotel, booking.code);
    if (isToolFailure(cancelled)) return cancelled;
    // The booking is no longer confirmed: the next tool needing a verified
    // booking should re-ask (a different reservation, or they are done).
    hotel.verifiedCode = null;
    const message = within
      ? `Cancelled. Because the booking's inside the ${PRICING.cancellationWindowHours}-hour window, one room-night ` +
        `(${speakUsd(forfeit)}) is forfeited; I'll refund ${speakUsd(booking.total - forfeit)} to the card on file.`
      : `Cancelled - well outside the ${PRICING.cancellationWindowHours}-hour window, so there's no penalty and no ` +
        `deposit is lost. I'll refund the full ${speakUsd(booking.total)} to the card on file - usually two to five business days.`;
    hotel.lastCancel = { message, callerTurns: turns };
    return {
      cancelled: true,
      code: booking.code,
      withinWindow: within,
      forfeit,
      refund: booking.total - forfeit,
      message,
    };
  },
});
