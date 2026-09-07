import { toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { AIRPORT_CAR } from "../catalogs.ts";
import { requireRoom } from "../hotel.ts";
import { isoDate, speakCode, speakUsd, spokenDate, spokenTime, TODAY } from "../records.ts";
import { addTicket, hotelSlot } from "../shared.ts";

/** Their `book_airport_car`: the hotel car, hotel-to-airport only, charged to the room. */
export default hotelSlot.updateTool({
  description:
    `Book the hotel car to the airport for an in-house guest: flat ${speakUsd(AIRPORT_CAR.flatPrice)} to ` +
    `${AIRPORT_CAR.destination}, seats up to ${AIRPORT_CAR.maxPassengers} with luggage, charged to the room. ` +
    "Departures only - getting FROM the airport is a taxi, rideshare or BART. Ask how many are riding; never assume one.",
  inputSchema: z.object({
    room: z.string(),
    pickupDate: isoDate("the pickup date"),
    pickupTime: z.string().describe("24-hour HH:MM"),
    passengers: z.number().int().min(1).max(AIRPORT_CAR.maxPassengers),
  }),
  execute({ room, pickupDate, pickupTime, passengers }, hotel) {
    const found = requireRoom(hotel, room);
    if ("error" in found) return toolFailure(found.error);
    if (pickupDate < TODAY)
      return toolFailure(`${spokenDate(pickupDate)} is in the past - re-confirm the date`);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(pickupTime))
      return toolFailure("the pickup time must be 24-hour HH:MM");
    const ticket = addTicket(
      hotel,
      "airport_car",
      "CAR",
      `room ${found.id}: ${pickupDate} ${pickupTime}, ${passengers} passengers`,
      {
        room: found.id,
        pickupDate,
        pickupTime,
        passengers,
        total: AIRPORT_CAR.flatPrice,
        status: "booked",
      },
    );
    return {
      booked: true,
      reference: ticket.code,
      spokenReference: speakCode(ticket.code),
      pickup: `${spokenDate(pickupDate)} at ${spokenTime(pickupTime)}, front entrance`,
      passengers,
      total: speakUsd(AIRPORT_CAR.flatPrice),
      next: "Confirm the time, the front-entrance pickup, the cost and the reference; no further tool call is needed.",
    };
  },
});
