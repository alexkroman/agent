import { clockTime } from "@alexkroman1/aai";
import { formatMoney } from "@alexkroman1/aai/utils";
import { z } from "zod";
import { departureClock, deskTool, FLIGHTS } from "../shared.ts";

/**
 * Their `search_flights`, with the same "be generous" behaviour their flight
 * prompt asks the model for: an unmatched route returns the whole schedule
 * rather than an empty list, so the desk can say what it DOES fly instead of
 * "nothing found" — which is what sends a caller to a human.
 *
 * `departsAfter` is declared with `clockTime()` rather than a bare string, so
 * "the afternoon one" is refused as `9am` and accepted as `14:00` BEFORE the
 * body runs — the padding is what makes the comparison against
 * {@link departureClock} a string comparison at all.
 */
export default deskTool("flight", {
  description:
    "The FLIGHT DESK's search: the schedule, matched on any part of the route, e.g. " +
    "'Boston' or 'Zurich to Boston', and optionally only what leaves at or after a time " +
    "of day. Omit the route to hear everything. Only usable while the call is at that " +
    "desk — from anywhere else it refuses, so call to_flight_assistant first.",
  inputSchema: z.object({
    route: z
      .string()
      .max(120)
      .describe("Route or city to match, e.g. 'Zurich to Boston'")
      .optional(),
    maxFare: z.number().positive().describe("Only flights at or under this fare").optional(),
    departsAfter: clockTime("Only flights departing at or after this time of day").optional(),
  }),
  // The state is not read at all any more: the desk gate was the only thing a
  // search needed it for, and `deskTool` owns that now.
  execute(args) {
    const needle = args.route?.trim().toLowerCase();
    const matched = FLIGHTS.filter(
      (f) =>
        (!needle || f.route.toLowerCase().includes(needle) || f.id.toLowerCase() === needle) &&
        (args.maxFare === undefined || f.fare <= args.maxFare) &&
        // A row whose departure is not a clock reading is left out of a
        // time-filtered search rather than compared against one — see
        // `departureClock`. Unfiltered searches are untouched.
        (args.departsAfter === undefined || (departureClock(f) ?? "") >= args.departsAfter),
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
