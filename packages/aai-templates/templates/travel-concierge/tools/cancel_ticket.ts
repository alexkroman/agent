import { requireDesk, stageAction, tripSlot } from "../shared.ts";

/**
 * SENSITIVE — their `cancel_ticket`. The most destructive thing on the call and
 * the clearest argument for the gate: staged, read back, and only applied by
 * `confirm_action`.
 */
export default tripSlot.updateTool({
  description:
    "The FLIGHT DESK's cancellation tool: cancel the caller's ticket outright. Only usable " +
    "while the call is at that desk. This does NOT cancel anything yet — it stages the " +
    "cancellation so you can read it back and hear a yes.",
  execute(_args, trip, ctx) {
    const offDesk = requireDesk(trip, "flight");
    if (offDesk) return offDesk;
    if (!trip.ticket) return { error: "There is no ticket to cancel." };
    return stageAction(ctx, trip, { kind: "cancel_ticket" });
  },
});
