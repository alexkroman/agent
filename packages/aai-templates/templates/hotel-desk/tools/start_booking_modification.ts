import { isToolFailure, toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { draftForModification } from "../booking.ts";
import { deskFlow } from "../desk.ts";
import { speakUsd, spokenDate, TODAY } from "../records.ts";
import { hotelSlot, requireVerified } from "../shared.ts";

/**
 * Open the modification flow on the verified booking — their
 * `start_booking_modification`, which `await`ed a `ModifyBookingTask` with the
 * booking pre-loaded. The draft is pre-filled here and the dialog enters
 * `booking.editing`, where the recording tools are open and `confirm_booking`
 * is not until something changes and is read back.
 *
 * The result carries the booking's FACTS, for the reason their task put them in
 * its instructions: the model is asked to read the booking back, so its actual
 * dates and amounts have to be in its context or it invents them.
 */
export default deskFlow.tool({
  description:
    "Start changing an existing, verified booking: dates, room type, room view, extras, party " +
    "size. This is the path for a guest whose room's view or type doesn't match what they " +
    "booked - it moves them. Identity fields are NOT changed here (record_followup, " +
    "kind identity_change) and a new card goes through update_card. NOT for cancellations.",
  when: "desk",
  inputSchema: z.object({}),
  execute: (_args, ctx) =>
    hotelSlot.update(ctx, (hotel) => {
      const booking = requireVerified(hotel);
      if (isToolFailure(booking)) return booking;
      if (booking.status !== "confirmed")
        return toolFailure("that booking was cancelled - nothing to modify");
      if (booking.checkOut < TODAY)
        return toolFailure("that stay already ended - can't modify a past booking");
      const room = hotel.rooms.find((r) => r.id === booking.roomId);
      if (room === undefined) return toolFailure(`room ${booking.roomId} is not on the floor plan`);
      hotel.draft = draftForModification(booking, room);
      const extras = booking.extras.length > 0 ? booking.extras.join(", ") : "none";
      return {
        loaded: {
          guest: `${booking.firstName} ${booking.lastName}`,
          room: `${room.type.replaceAll("_", " ")}, ${room.view} view, room ${room.id}`,
          checkIn: spokenDate(booking.checkIn),
          checkOut: spokenDate(booking.checkOut),
          guests: booking.guests,
          extras,
          total: speakUsd(booking.total),
        },
        instructions:
          "Read the booking back briefly in one sentence and ask what the caller wants to change. " +
          "These are the ONLY facts to read back - never invent dates or amounts. Run set_stay " +
          "before choose_room when changing dates.",
      };
    }),
  send: { type: "MODIFY_STARTED" },
});
