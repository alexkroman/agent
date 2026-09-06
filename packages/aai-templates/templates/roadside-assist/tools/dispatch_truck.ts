import { isToolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { roadsideCall } from "../call.ts";
import {
  assignTruck,
  describeVehicle,
  etaMinutes,
  quoteFee,
  rateFor,
  roadsideSlot,
  TRUCK_FOR,
} from "../shared.ts";

/**
 * Send the truck.
 *
 * **Idempotent on purpose, and that is what makes the state's `toolChoice` pin
 * safe.** `onCall.dispatching` pins the model to this tool, so it is called on
 * every step of every turn for the rest of the call — which is exactly the
 * guarantee wanted ("do not tell a stranded caller a truck is coming without
 * sending one") and would be a fleet of trucks if a second call rolled a second
 * one. So the job is written once and every later call answers with the job
 * that already exists, refreshed ETA and all.
 *
 * It also means the tool must need nothing the caller has not already said: a
 * pinned step cannot ask a question. Everything here comes off the slot, except
 * the destination and the distance, which the caller gives once and which
 * default to the nearest approved shop when they have no preference.
 */
export default roadsideCall.tool({
  description:
    "Dispatch the truck and price the tow. Call this once the caller has accepted the fee. " +
    "Calling it again on the same call reports the SAME job — it never sends a second truck.",
  when: "onCall.dispatching",
  inputSchema: z.object({
    destination: z
      .string()
      .max(200)
      .describe("Where the vehicle is going — a shop, a dealer, or 'nearest approved shop'"),
    towMiles: z
      .number()
      .min(0)
      .max(500)
      .describe("Road miles from the vehicle to that destination. Use 0 for a roadside fix."),
  }),
  execute: (args, ctx) =>
    roadsideSlot.update(ctx, (state) => {
      // Every later pinned step lands here. A COPY rather than the draft's own
      // object: what a read hands out is frozen, and aliasing a draft into a
      // result is how a value escapes the mutation window it was made in.
      if (state.job !== null) return { ...state.job, alreadyDispatched: true };

      // Unreachable while the gate holds — `onCall.dispatching` is four states
      // downstream of `report_location`. Reported rather than thrown for the
      // reason every guard in this template is: this runs mid-call, and a
      // sentence the model can act on beats an exception down a phone line.
      if (state.situation === null || state.where === null || state.vehicle === null) {
        return {
          error:
            "Nothing is on file for this call yet — no location, vehicle or situation. Take " +
            "those first with report_location.",
        };
      }

      const truck = assignTruck(state.situation);
      if (isToolFailure(truck)) return truck;

      const eta = etaMinutes(truck, state.where.safeToWait);
      const quote = quoteFee(rateFor(state.coverage), args.towMiles);
      state.job = {
        callsign: truck.callsign,
        kind: TRUCK_FOR[state.situation],
        destination: args.destination,
        towMiles: args.towMiles,
        etaMinutes: eta,
        quote,
      };
      state.log.push(`Dispatched ${truck.callsign}, ETA ${eta} min, total ${quote.total}`);
      return {
        ...state.job,
        alreadyDispatched: false,
        lookFor: describeVehicle(state.vehicle),
        at: state.where.described,
      };
    }),
});
