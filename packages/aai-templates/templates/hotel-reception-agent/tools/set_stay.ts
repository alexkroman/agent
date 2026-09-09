import { toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { bookingStatus, nextStep, requote } from "../booking.ts";
import { deskFlow, IN_BOOKING } from "../desk.ts";
import { describeRoomOptions, listRoomOptions } from "../hotel.ts";
import { daysBetween, isoDate, MAX_PARTY_SIZE, spokenDate, TODAY } from "../records.ts";
import { hotelSlot } from "../session.ts";
import { bookingByCode } from "../shared.ts";

const MAX_NIGHTS = 30;

/**
 * Record the stay — their `set_stay`, on both the booking and the modification
 * task, since the draft's `mode` says which.
 *
 * **Sold-out dates are NOT persisted.** If the model drifted forward without
 * re-setting, the booking would carry invalid dates; the caller needs different
 * dates anyway, so the refusal (which sends no event) is the right shape.
 *
 * **A re-dated pick that dies re-opens the OFFER.** Their `_must_offer` was
 * armed only where a pick was invalidated by new dates — not on the first
 * `set_stay` (nothing to invalidate) and not when the pick survives (re-arming
 * would rewind a settled step). `OFFER` here follows the same three cases.
 */
export default deskFlow.tool({
  description:
    "Record the stay dates and party size. The result lists each available room type with " +
    'its view and rate - reference material for OFFERING the choice and answering "how much?". ' +
    "Never pick a type yourself. Pass the FULL stay even when only one field changes.",
  when: IN_BOOKING,
  inputSchema: z.object({
    checkIn: isoDate("the check-in date"),
    checkOut: isoDate("the check-out date"),
    guests: z
      .number()
      .int()
      .min(1)
      .max(MAX_PARTY_SIZE)
      .describe("Guests in the room - ask if not said"),
  }),
  execute: ({ checkIn, checkOut, guests }, ctx) =>
    hotelSlot.update(ctx, (hotel) => {
      const d = hotel.draft;
      if (d === null)
        return toolFailure("No booking flow is open - call start_room_booking first.");
      if (checkOut <= checkIn) return toolFailure("check-out must be after check-in");
      if (daysBetween(checkIn, checkOut) > MAX_NIGHTS)
        return toolFailure(`the max stay is ${MAX_NIGHTS} nights`);
      const existing = d.existingCode === null ? undefined : bookingByCode(hotel, d.existingCode);
      // An in-house booking's existing check-in IS in the past, and the caller
      // should be able to keep it while shifting the check-out.
      if (checkIn < TODAY && checkIn !== existing?.checkIn)
        return toolFailure("check-in can't be in the past");

      const options = listRoomOptions(hotel, {
        checkIn,
        checkOut,
        guests,
        smoking: d.mode === "modify" ? d.smoking : undefined,
        excludeCode: d.existingCode,
      });
      if (options.length === 0) {
        return toolFailure(
          `sold out for ${spokenDate(checkIn)} to ${spokenDate(checkOut)}, ${guests} guests - dates not ` +
            "recorded; offer the nights either side, or the waitlist (add_to_waitlist).",
        );
      }

      d.checkIn = checkIn;
      d.checkOut = checkOut;
      d.guests = guests;
      const hadRoom = d.roomType !== null;
      const survives =
        hadRoom &&
        options.some((o) => o.type === d.roomType && (d.view === null || o.view === d.view));
      let offer = false;
      if (!survives) {
        d.roomType = null;
        d.view = null;
        if (hadRoom) offer = true;
      }
      requote(hotel, d);
      return {
        recorded: `${spokenDate(checkIn)} to ${spokenDate(checkOut)}, ${guests} guests`,
        nights: daysBetween(checkIn, checkOut),
        options: describeRoomOptions(options),
        note:
          "one line per room type + view - the price is that pairing's, so the view is part of " +
          "what the caller is picking",
        status: offer
          ? "the room the caller had chosen is not available for these dates - offer the options " +
            "above and ask which they want; choose_room opens once they have answered"
          : bookingStatus(d),
        next: offer ? ("OFFER" as const) : nextStep(d),
      };
    }),
  sendFrom: (result) => ({ type: result.next }),
});
