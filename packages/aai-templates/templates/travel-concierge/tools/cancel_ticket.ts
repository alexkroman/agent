import { stageAction, tripSlot } from "../shared.ts";

/**
 * SENSITIVE — their `cancel_ticket`. The most destructive thing on the call and
 * the clearest argument for the gate: staged, read back, and only applied by
 * `confirm_action`.
 */
export const cancelTicket = tripSlot.tool({
  description:
    "Cancel the caller's ticket outright. This does NOT cancel anything yet — " +
    "it stages the cancellation so you can read it back and hear a yes.",
  execute(_args, trip) {
    if (!trip.ticket) return { error: "There is no ticket to cancel." };
    return stageAction(trip, { kind: "cancel_ticket" });
  },
});
