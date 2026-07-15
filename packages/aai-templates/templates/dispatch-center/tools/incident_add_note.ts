import { tool } from "@alexkroman1/aai";
import { z } from "zod";
import { findIncident, getState, saveState } from "../shared.ts";

export const incidentAddNote = tool({
  description: "Add a situational update note to an incident.",
  parameters: z.object({
    incidentId: z.string().describe("The incident ID"),
    note: z.string().describe("The note to add"),
    source: z.string().describe("Who reported this — unit callsign or caller").optional(),
  }),
  async execute(args, ctx) {
    const state = await getState(ctx.kv);
    const inc = findIncident(state, args.incidentId);
    if ("error" in inc) return inc;

    const entry = args.source ? `[${args.source}] ${args.note}` : args.note;
    inc.notes.push(entry);
    inc.timeline.push({ time: Date.now(), event: entry });
    inc.updatedAt = Date.now();
    await saveState(ctx.kv, state);

    return {
      incidentId: args.incidentId,
      noteAdded: entry,
      totalNotes: inc.notes.length,
    };
  },
});
