import { toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { spokenDate, spokenTime } from "../records.ts";
import { findReservation } from "../restaurant.ts";
import { hotelSlot } from "../session.ts";
import { note } from "../shared.ts";

/** Their `cancel_restaurant_reservation`: last name + RES code, no card, no email. */
export default hotelSlot.updateTool({
  description:
    "Cancel a restaurant reservation. Verifies with last name + the RES confirmation code.",
  inputSchema: z.object({ lastName: z.string().min(1), confirmationCode: z.string().min(1) }),
  execute({ lastName, confirmationCode }, hotel) {
    const reservation = findReservation(hotel, lastName, confirmationCode);
    if (reservation === undefined || reservation.status !== "confirmed") {
      return toolFailure("Couldn't find a matching confirmed reservation.");
    }
    reservation.status = "cancelled";
    note(hotel, `Cancelled reservation ${reservation.code}`);
    return {
      cancelled: true,
      code: reservation.code,
      message: `Reservation for ${spokenTime(reservation.time)} on ${spokenDate(reservation.date)} cancelled.`,
    };
  },
});
