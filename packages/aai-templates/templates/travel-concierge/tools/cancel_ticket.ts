import { z } from "zod";
import { deskUpdateTool, stageAction } from "../shared.ts";

/**
 * SENSITIVE — their `cancel_ticket`. The most destructive thing on the call and
 * the clearest argument for the gate: staged, read back, and only applied by
 * `confirm_action`.
 */
export default deskUpdateTool("flight", {
  description:
    "The FLIGHT DESK's cancellation tool: cancel the caller's ticket outright. Only usable " +
    "while the call is at that desk. This does NOT cancel anything yet — it stages the " +
    "cancellation so you can read it back and hear a yes.",
  // The desk's one tool that takes nothing: declared anyway, so `deskUpdateTool`
  // has a single code path rather than a branch for the no-argument case.
  inputSchema: z.object({}),
  execute(_args, trip, ctx) {
    if (!trip.ticket) return { error: "There is no ticket to cancel." };
    return stageAction(ctx, trip, { kind: "cancel_ticket" });
  },
});
