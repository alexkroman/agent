import { isToolFailure, tool } from "@alexkroman1/aai";
import { z } from "zod";
import { dispatchSlot, findIncident, logEvent } from "../shared.ts";

export const incidentAddNote = tool({
  description: "Add a situational update note to an incident's timeline.",
  inputSchema: z.object({
    incidentId: z.string().max(20).describe("The incident ID"),
    note: z.string().max(1000).describe("The note to add"),
    source: z.string().max(100).describe("Who reported this — unit callsign or caller").optional(),
  }),
  async execute(args, ctx) {
    return dispatchSlot.update(ctx, (state) => {
      const inc = findIncident(state, args.incidentId);
      if (isToolFailure(inc)) return inc;

      const entry = args.source ? `[${args.source}] ${args.note}` : args.note;
      logEvent(inc, entry);

      return {
        incidentId: args.incidentId,
        noteAdded: entry,
        timelineEntries: inc.timeline.length,
      };
    });
  },
});
