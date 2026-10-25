import { toolFailure } from "@alexkroman1/aai/utils";
import { deskGate, gateFlow, stageAction, tripSlot } from "../shared.ts";

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
  ui: { icon: "\u{1F5D1}", label: "Staging cancellation" },
  dialog: gateFlow,
  send: { type: "STAGED" },
  require: (trip) =>
    deskGate("flight")(trip) ??
    (trip.ticket ? undefined : toolFailure("There is no ticket to cancel.")),
  execute: (_args, trip) => stageAction(trip, { kind: "cancel_ticket" }),
});
