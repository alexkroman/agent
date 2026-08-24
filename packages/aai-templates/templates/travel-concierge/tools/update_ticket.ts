import { z } from "zod";
import { requireDesk, stageAction, tripSlot } from "../shared.ts";

/**
 * SENSITIVE — their `update_ticket_to_new_flight`, behind the confirmation
 * gate. It changes nothing: it stages the move and hands back the sentence to
 * read aloud. `confirm_action` is what applies it.
 */
export default tripSlot.updateTool({
  description:
    "The FLIGHT DESK's rebooking tool: move the caller's ticket to a different flight. " +
    "Only usable while the call is at that desk. This does NOT change the ticket — it " +
    "stages the change so you can read it back and hear a yes.",
  inputSchema: z.object({
    flightId: z.string().max(20).describe("The flight to move to, e.g. 'LX52'"),
  }),
  execute(args, trip, ctx) {
    const offDesk = requireDesk(trip, "flight");
    if (offDesk) return offDesk;
    if (!trip.ticket) {
      return { error: "This caller has no ticket to move — it was cancelled on this call." };
    }
    return stageAction(ctx, trip, { kind: "update_ticket", flightId: args.flightId.toUpperCase() });
  },
});
