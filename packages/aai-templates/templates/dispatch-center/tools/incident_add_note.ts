import { tool } from "aai";
import { z } from "zod";
import type { KV } from "../shared.ts";
import { getState, now, saveState } from "../shared.ts";

export const incidentAddNote = tool({
  description: "Add a situational update note to an incident.",
  parameters: z.object({
    incidentId: z.string().describe("The incident ID"),
    note: z.string().describe("The note to add"),
    source: z.string().describe("Who reported this — unit callsign or caller").optional(),
  }),
  async execute(args, ctx: { kv: KV }) {
    const state = await getState(ctx.kv);
    const inc = state.incidents[args.incidentId];
    if (!inc) return { error: `Incident ${args.incidentId} not found` };

    const entry = args.source ? `[${args.source}] ${args.note}` : args.note;
    inc.notes.push(entry);
    inc.timeline.push({ time: now(), event: entry });
    inc.updatedAt = now();
    await saveState(ctx.kv, state);

    return {
      incidentId: args.incidentId,
      noteAdded: entry,
      totalNotes: inc.notes.length,
    };
  },
});
