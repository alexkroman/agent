import { formatMoney } from "@alexkroman1/aai/utils";
import { z } from "zod";
import { FLIGHTS, requireDesk, tripSlot } from "../shared.ts";

/**
 * Their `search_flights`, with the same "be generous" behaviour their flight
 * prompt asks the model for: an unmatched route returns the whole schedule
 * rather than an empty list, so the desk can say what it DOES fly instead of
 * "nothing found" — which is what sends a caller to a human.
 */
export default tripSlot.tool({
  description:
    "The FLIGHT DESK's search: the schedule, matched on any part of the route, e.g. " +
    "'Boston' or 'Zurich to Boston'. Omit the route to hear everything. Only usable while " +
    "the call is at that desk — from anywhere else it refuses, so call to_flight_assistant " +
    "first.",
  inputSchema: z.object({
    route: z
      .string()
      .max(120)
      .describe("Route or city to match, e.g. 'Zurich to Boston'")
      .optional(),
    maxFare: z.number().positive().describe("Only flights at or under this fare").optional(),
  }),
  execute(args, trip) {
    const offDesk = requireDesk(trip, "flight");
    if (offDesk) return offDesk;
    const needle = args.route?.trim().toLowerCase();
    const matched = FLIGHTS.filter(
      (f) =>
        (!needle || f.route.toLowerCase().includes(needle) || f.id.toLowerCase() === needle) &&
        (args.maxFare === undefined || f.fare <= args.maxFare),
    );
    const results = matched.length > 0 ? matched : FLIGHTS;
    return {
      widened: matched.length === 0,
      flights: results.map((f) => ({
        flight: f.id,
        route: f.route,
        departs: f.departs,
        arrives: f.arrives,
        fare: formatMoney(f.fare),
        seatsLeft: f.seatsLeft,
      })),
    };
  },
});
