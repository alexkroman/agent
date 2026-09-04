import { formatMoney } from "@alexkroman1/aai/utils";
import { FLIGHTS, tripSlot } from "../shared.ts";

/**
 * Their `fetch_user_flight_information`, which the notebook runs ONCE and
 * pastes into the prompt. A voice session's prompt is fixed at connect and the
 * ticket changes mid-call, so it is a tool the concierge can re-read instead.
 */
export default tripSlot.tool({
  description:
    "Look up the caller's current booking: who they are, their ticket, and " +
    "anything already reserved on this call. Call this before quoting or " +
    "changing anything.",
  execute(_args, trip) {
    const flight = trip.ticket ? FLIGHTS.find((f) => f.id === trip.ticket?.flightId) : undefined;
    return {
      passenger: trip.passenger,
      ticket:
        trip.ticket && flight
          ? {
              reference: trip.ticket.reference,
              flight: flight.id,
              route: flight.route,
              departs: flight.departs,
              arrives: flight.arrives,
              fare: formatMoney(flight.fare),
            }
          : null,
      bookings: trip.bookings.map((b) => ({
        reference: b.reference,
        what: b.summary,
        price: formatMoney(b.price),
      })),
    };
  },
});
