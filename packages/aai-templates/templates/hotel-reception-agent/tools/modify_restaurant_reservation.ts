import { isToolFailure, toolFailure } from "@alexkroman1/aai";
import { plural } from "@alexkroman1/aai/utils";
import { z } from "zod";
import {
  clockTime,
  DINNER_SLOTS,
  isoDate,
  MAX_PARTY_SIZE,
  speakCode,
  spokenDate,
  spokenTime,
  TODAY,
} from "../records.ts";
import { findReservation, modifyReservation, openDinnerSlots } from "../restaurant.ts";
import { hotelSlot } from "../shared.ts";

/**
 * Move a reservation — their `modify_restaurant_reservation`, one step, same
 * code. `newPartySize` is OMITTED when the caller keeps the same number, never
 * filled with a guess; the result carries the size so a wrong count is caught
 * on the read-back.
 */
export default hotelSlot.updateTool({
  description:
    "Move a confirmed restaurant reservation to a new date and time (and optionally a new party size), " +
    "keeping its code. Verifies with last name + RES code. Omit newPartySize unless the caller states a " +
    "new number. Read the new details back before calling, and relay the party size from the result.",
  inputSchema: z.object({
    lastName: z.string().min(1),
    confirmationCode: z.string().min(1),
    newDate: isoDate("the new date"),
    newTime: clockTime("the new time"),
    newPartySize: z.number().int().min(1).max(MAX_PARTY_SIZE).optional(),
  }),
  execute({ lastName, confirmationCode, newDate, newTime, newPartySize }, hotel) {
    if (newDate < TODAY) return toolFailure("the new date can't be in the past");
    if (!(DINNER_SLOTS as readonly string[]).includes(newTime)) {
      return toolFailure(
        `the restaurant seats at ${DINNER_SLOTS.map(spokenTime).join(", ")} - pick one of those`,
      );
    }
    const reservation = findReservation(hotel, lastName, confirmationCode);
    if (reservation === undefined || reservation.status !== "confirmed") {
      return toolFailure("Couldn't find a matching confirmed reservation.");
    }
    const updated = modifyReservation(
      hotel,
      reservation.code,
      newDate,
      newTime,
      newPartySize ?? null,
    );
    if (isToolFailure(updated)) {
      const party = newPartySize ?? reservation.partySize;
      const open = openDinnerSlots(hotel, newDate, party).filter((slot) => slot !== newTime);
      return toolFailure(
        `No table for a party of ${party} at ${spokenTime(newTime)} on ${spokenDate(newDate)}.` +
          (open.length > 0
            ? ` Open that evening: ${open.map(spokenTime).join(", ")}.`
            : " Nothing is open that evening."),
      );
    }
    return {
      code: updated.code,
      spokenCode: speakCode(updated.code),
      date: spokenDate(updated.date),
      time: spokenTime(updated.time),
      partySize: updated.partySize,
      message:
        `Done - the reservation is now ${spokenTime(updated.time)} on ${spokenDate(updated.date)} for ` +
        `${updated.partySize} ${plural(updated.partySize, "guest")}, same code. Confirm the date, time AND ` +
        "party size to the caller - if the size isn't what they expect, this is their chance to catch it.",
    };
  },
});
