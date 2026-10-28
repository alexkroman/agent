import { z } from "zod";
import { callFlow, dispatchSlot, logEvent, requireIncident } from "../shared.ts";

/** Gated on `working` — there is nothing to annotate before anything is logged. */
export default dispatchSlot.updateTool({
  effect: "write",
  description: "Add a situational update note to an incident's timeline.",
  dialog: callFlow,
  when: "working",
  inputSchema: z.object({
    incidentId: z.string().max(20).describe("The incident ID"),
    note: z.string().max(1000).describe("The note to add"),
    source: z.string().max(100).describe("Who reported this — unit callsign or caller").optional(),
  }),
  require: (state, { incidentId }) => requireIncident(state, incidentId),
  execute(args, state, ctx) {
    const inc = state.incidents[args.incidentId]!;
    const entry = args.source ? `[${args.source}] ${args.note}` : args.note;
    logEvent(inc, entry, ctx.now());
    return { incidentId: args.incidentId, noteAdded: entry, timelineEntries: inc.timeline.length };
  },
});
