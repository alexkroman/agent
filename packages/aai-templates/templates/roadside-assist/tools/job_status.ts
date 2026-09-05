import { z } from "zod";
import { ON_THE_LINE, roadsideCall } from "../call.ts";
import { describeVehicle, rateFor, roadsideSlot } from "../shared.ts";

/**
 * Everything this call has established so far — for the caller who asks "what
 * did you say my fee was?" three turns later.
 *
 * Gated on the PARENT: `"onCall"` matches all five phases, so this is legal
 * throughout the call and refused the moment `abandoned` is reached. That is
 * not the same as ungated, and the difference is the point — a read that still
 * answered after the caller hung up would be a desk reporting on a call that no
 * longer exists.
 *
 * The result carries `state`, `done` and the active `instruction` because
 * `roadsideCall.tool` writes them, which is also how the model re-reads its own
 * position after a turn that called nothing.
 */
export default roadsideCall.tool({
  description:
    "What this call has established so far: location, vehicle, plan, and the truck if one has " +
    "been sent. Use it to answer a caller repeating a question rather than asking them again.",
  when: ON_THE_LINE,
  inputSchema: z.object({}),
  execute: (_args, ctx) => {
    const state = roadsideSlot.get(ctx);
    return {
      where: state.where?.described ?? null,
      safeToWait: state.where?.safeToWait ?? null,
      vehicle: state.vehicle === null ? null : describeVehicle(state.vehicle),
      situation: state.situation,
      plan: rateFor(state.coverage).name,
      feeDisclosureAccepted: state.disclosureAcceptedAt !== null,
      job: state.job,
      log: state.log,
    };
  },
});
