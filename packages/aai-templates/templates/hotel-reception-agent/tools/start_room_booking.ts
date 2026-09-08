import { toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { bookingStatus, draftForNewBooking } from "../booking.ts";
import { deskFlow } from "../desk.ts";
import { speakCode } from "../records.ts";
import { callerTurns, hotelSlot } from "../shared.ts";

/**
 * Open the room-booking flow — their `start_room_booking`, which `await`ed a
 * `BookRoomTask`. Here it opens the `booking` dialog, whose states carry the
 * task's instructions and whose gates carry its tool set.
 *
 * **The double-booking guard is theirs, and it reads `ctx.messages`.** After a
 * booking completes the model sometimes re-enters this flow on its own and
 * re-fills every field from the transcript — no caller input — committing a
 * duplicate into another room. If the caller has not spoken since the last
 * booking there is nothing to book, so this REFUSES, and a refusal sends no
 * event: the dialog stays at the desk. A real second room (a family's extra
 * room) is always preceded by the caller asking, so that path stays open.
 */
export default deskFlow.tool({
  description:
    "Start the room-booking flow. Call it the MOMENT the caller wants to book - never " +
    "pre-collect name, email, phone or card first; the flow gathers everything. Not for " +
    "changing an existing booking (start_booking_modification).",
  when: "desk",
  inputSchema: z.object({}),
  execute: (_args, ctx) =>
    hotelSlot.update(ctx, (hotel) => {
      const prev = hotel.lastBooking;
      if (prev !== null && callerTurns(ctx.messages) <= prev.callerTurns) {
        return toolFailure(
          `This booking is already complete - confirmation ${speakCode(prev.code)} was issued ` +
            "moments ago and the caller has the code and total. Do NOT book again or repeat the " +
            "confirmation. If they actually want an ADDITIONAL room, ask them to confirm that " +
            "first; otherwise ask if there is anything else.",
        );
      }
      hotel.draft = draftForNewBooking();
      return {
        opened: true,
        instructions:
          "Help the caller book a room. Record anything they have already mentioned - dates, " +
          "party size, room type - then ask only for what is still missing, one question per turn.",
        status: bookingStatus(hotel.draft),
      };
    }),
  send: { type: "BOOKING_STARTED" },
});
