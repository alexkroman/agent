import { failable, isToolFailure, orFail, type ToolFailure, toolFailure } from "@alexkroman1/aai";
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
 * sentence saying what is missing.
 *
 * Unreachable while the gate holds: `onCall.dispatching` is four states
 * downstream of `report_location`. Reported rather than thrown for the reason
 * every guard in this template is — this runs mid-call, and a sentence the
 * model can act on beats an exception down a phone line.
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
 * The whole decision, off the slot and against the yard, before anything is
 * written.
 *
 * **`failable` pays here and would not have paid inside the `update` body it
 * came out of.** The SDK's own rule is that the wrapper earns its three lines
 * on a NAMED helper returning `T | ToolFailure` and not on an inline mutator
 * with one or two guards; this is the named helper, it forwards two failures
 * ({@link dispatchBasis} and a yard that has nothing free or does not answer),
 * and each `orFail` replaces an `if (isToolFailure(x)) return x;` that said
 * nothing about roadside assistance.
 *
 * It is also deliberately OUTSIDE the mutation window. `reserveTruck` awaits
 * the yard, and a `slot.update` body is synchronous — so the shape is claim,
 * await, then write, which is the same order `plan-and-execute`'s
 * `work_next_step` uses for a body that has to call out mid-tool.
 */
const planDispatch = failable(
  async (state: FrozenRoadsideState, callKey: string, towMiles: number): Promise<DispatchPlan> => {
    const basis = orFail(dispatchBasis(state));
    const truck = orFail(await reserveTruck(basis.situation, callKey));
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
 * safe.** `onCall.dispatching` pins the model to this tool, so it is called on
 * every step of every turn for the rest of the call — which is exactly the
 * guarantee wanted ("do not tell a stranded caller a truck is coming without
 * sending one") and would be a fleet of trucks if a second call rolled a second
 * one. So the job is written once and every later call answers with the job
 * that already exists, refreshed ETA and all.
 *
 * The idempotency is stated TWICE, and both are load-bearing because the body
 * awaits. The slot check below catches the ordinary repeat; the yard's own
 * `callKey` hold catches two pinned calls in the SAME step, which the LLM loop
 * runs concurrently and which would otherwise both read `job === null` and both
 * take a truck. `yard.ts` has the argument.
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
  execute: async (args, ctx) => {
    // A COPY rather than the stored object: what a read hands out is frozen,
    // and spreading it is what makes the result a plain value again.
    const dispatched = roadsideSlot.get(ctx).job;
    if (dispatched !== null) return { ...dispatched, alreadyDispatched: true };

    const plan = await planDispatch(roadsideSlot.get(ctx), ctx.sessionId, args.towMiles);
    if (isToolFailure(plan)) return plan;

    return roadsideSlot.update(ctx, (state) => {
      // Read again inside the window: the yard round trip above is an await, so
      // a concurrent pinned call may have landed here first. It holds the same
      // truck — that is the yard's `callKey` contract — and the job it wrote is
      // the one this call keeps.
      if (state.job !== null) return { ...state.job, alreadyDispatched: true };
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
      return { ...state.job, alreadyDispatched: false, lookFor: plan.lookFor, at: plan.at };
    });
  },
});
