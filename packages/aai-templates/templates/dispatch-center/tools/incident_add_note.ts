import { tool } from "@alexkroman1/aai";
import { z } from "zod";
import { dashboardEvent, findIncident, logEvent, updateState } from "../shared.ts";

export const incidentAddNote = tool({
  description: "Add a situational update note to an incident's timeline.",
  parameters: z.object({
    incidentId: z.string().max(20).describe("The incident ID"),
    note: z.string().max(1000).describe("The note to add"),
    source: z.string().max(100).describe("Who reported this — unit callsign or caller").optional(),
  }),
  async execute(args, ctx) {
    return updateState(
      ctx.kv,
      ctx.sessionId,
      (state) => {
        const inc = findIncident(state, args.incidentId);
        if ("error" in inc) return inc;

        const entry = args.source ? `[${args.source}] ${args.note}` : args.note;
        logEvent(inc, entry);

        return {
          incidentId: args.incidentId,
          noteAdded: entry,
          timelineEntries: inc.timeline.length,
        };
      },
      (state) => ctx.send("incidents", dashboardEvent(state)),
    );
  },
});
