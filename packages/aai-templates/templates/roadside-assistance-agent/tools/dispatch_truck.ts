import { failable, orFail, type ToolFailure, toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { roadsideCall } from "../call.ts";
import {
  describeVehicle,
  etaMinutes,
  type FrozenRoadsideState,
  type Quote,
  quoteFee,
  rateFor,
  roadsideSlot,
  type Situation,
  type Truck,
} from "../shared.ts";
import { reserveTruck } from "../yard.ts";

/**
 * Everything the desk needs off the slot before a truck can move — or the
 * sentence saying what is missing. Unreachable while the gate holds:
 * `onCall.dispatching` is four states downstream of `report_location`.
 */
function dispatchBasis(state: FrozenRoadsideState): DispatchBasis | ToolFailure {
  if (state.situation === null || state.where === null || state.vehicle === null) {
    return toolFailure(
      "Nothing is on file for this call yet — no location, vehicle or situation. Take those " +
        "first with report_location.",
    );
  }
  return { situation: state.situation, where: state.where, vehicle: state.vehicle };
}

interface DispatchBasis {
  readonly situation: Situation;
  readonly where: NonNullable<FrozenRoadsideState["where"]>;
  readonly vehicle: NonNullable<FrozenRoadsideState["vehicle"]>;
}

interface DispatchPlan {
  readonly truck: Truck;
  readonly etaMinutes: number;
  readonly quote: Quote;
  readonly lookFor: string;
  readonly at: string;
}

/**
 * The whole decision, off the slot and against the yard. `failable` earns its
 * keep on a NAMED helper that forwards two failures ({@link dispatchBasis} and
 * a yard that has nothing free or does not answer).
 */
const planDispatch = failable(
  async (
    state: FrozenRoadsideState,
    callKey: string,
    towMiles: number,
    now: number,
  ): Promise<DispatchPlan> => {
    const basis = orFail(dispatchBasis(state));
    const truck = orFail(await reserveTruck(basis.situation, callKey, now));
    return {
      truck,
      etaMinutes: etaMinutes(truck, basis.where.safeToWait),
      quote: quoteFee(rateFor(state.coverage), towMiles),
      lookFor: describeVehicle(basis.vehicle),
      at: basis.where.described,
    };
  },
);

/**
 * Send the truck.
 *
 * **Idempotent on purpose, and that is what makes the state's `toolChoice` pin
 * safe.** `onCall.dispatching` pins the model to this tool, so it fires on the
 * first step of every later turn — the guarantee wanted ("do not tell a
 * stranded caller a truck is coming without sending one"), and a fleet of
 * trucks if a second call rolled a second one. So the job is written once and
 * every later call answers with the job that already exists.
 *
 * The yard is asked in `prepare`, OUTSIDE the synchronous window, and the
 * idempotency is stated twice because of that await: the window re-reads
 * `job` for the ordinary repeat, and the yard's own `callKey` hold catches two
 * pinned calls in the SAME step, which the LLM loop runs concurrently.
 */
export default roadsideSlot.updateTool({
  effect: "write",
  description:
    "Dispatch the truck and price the tow. Call this once the caller has accepted the fee. " +
    "Calling it again on the same call reports the SAME job — it never sends a second truck.",
  dialog: roadsideCall,
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
  // Nothing to plan when a truck is already out; the window answers that job.
  prepare: (args, state, ctx) =>
    state.job === null ? planDispatch(state, ctx.sessionId, args.towMiles, ctx.now()) : null,
  execute(args, state, plan) {
    if (state.job !== null) return { ...state.job, alreadyDispatched: true as const };
    // `prepare` plans exactly when no job is on file, and nothing else writes one.
    if (plan === null) throw new Error("dispatch_truck: no job on file and nothing planned");
    state.job = {
      callsign: plan.truck.callsign,
      kind: plan.truck.kind,
      destination: args.destination,
      towMiles: args.towMiles,
      etaMinutes: plan.etaMinutes,
      quote: plan.quote,
    };
    state.log.push(
      `Dispatched ${plan.truck.callsign}, ETA ${plan.etaMinutes} min, total ${plan.quote.total}`,
    );
    return { ...state.job, alreadyDispatched: false as const, lookFor: plan.lookFor, at: plan.at };
  },
});
