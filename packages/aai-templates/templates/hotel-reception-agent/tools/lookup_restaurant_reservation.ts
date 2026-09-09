import { toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { spokenDate, spokenTime } from "../records.ts";
import { findReservation } from "../restaurant.ts";
import { hotelSlot } from "../session.ts";

/** Their `lookup_restaurant_reservation`: restaurants verify with last name + RES code. */
export default hotelSlot.tool({
  description:
    "Read-only lookup of a confirmed restaurant reservation by last name and RES code - to recall its " +
    "details, or before a change that keeps some of them the same.",
  inputSchema: z.object({ lastName: z.string().min(1), confirmationCode: z.string().min(1) }),
  execute({ lastName, confirmationCode }, hotel) {
    const reservation = findReservation(hotel, lastName, confirmationCode);
    if (reservation === undefined || reservation.status !== "confirmed") {
      return toolFailure("Couldn't find a matching confirmed reservation.");
    }
    return {
      code: reservation.code,
      guest: `${reservation.firstName} ${reservation.lastName}`,
      date: spokenDate(reservation.date),
      time: spokenTime(reservation.time),
      partySize: reservation.partySize,
      notes: reservation.notes,
    };
  },
});
