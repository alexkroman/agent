import { toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { requireRoom } from "../hotel.ts";
import { isoDate, speakCode } from "../records.ts";
import { addTicket, hotelSlot } from "../shared.ts";

/** Their `request_flight_reconfirmation`: the concierge calls the carrier and rings the room. */
export default hotelSlot.updateTool({
  description:
    "Log a flight-reconfirmation request for an in-house guest: the concierge calls the carrier and " +
    "rings the room with the result. Collect ALL the details and read the booking reference back " +
    "before calling - a wrong reference makes the request useless. The flight is NOT confirmed by this.",
  inputSchema: z.object({
    room: z.string(),
    airline: z.string().min(1),
    flightNumber: z.string().min(1).describe("Airline code and number as given, e.g. IB 6174"),
    flightDate: isoDate("the flight date").describe(
      "YYYY-MM-DD - resolve a weekday against today and say the date back first",
    ),
    bookingReference: z.string().min(1).describe("Letters and digits only"),
    seatCheck: z.boolean().describe("True if the guest also wants their seat assignment checked"),
  }),
  execute(args, hotel) {
    const found = requireRoom(hotel, args.room);
    if ("error" in found) return toolFailure(found.error);
    // Spoken codes arrive with unpredictable spaces and dashes.
    const flightNumber = args.flightNumber.replaceAll(/[^a-z0-9]/gi, "").toUpperCase();
    const bookingReference = args.bookingReference.replaceAll(/[^a-z0-9]/gi, "").toUpperCase();
    const ticket = addTicket(
      hotel,
      "flight_reconfirmation",
      "FLT",
      `room ${found.id}: ${args.airline} ${flightNumber} on ${args.flightDate}`,
      {
        room: found.id,
        airline: args.airline.trim(),
        flightNumber,
        flightDate: args.flightDate,
        bookingReference,
        seatCheck: args.seatCheck,
        status: "pending",
      },
    );
    return {
      logged: true,
      reference: ticket.code,
      spokenReference: speakCode(ticket.code),
      next:
        "Tell the caller the concierge will call the carrier and ring their room with the result within the hour" +
        (args.seatCheck ? ", including the seat check" : "") +
        ". The flight is NOT confirmed yet - never say it is; promise the callback instead.",
    };
  },
});
