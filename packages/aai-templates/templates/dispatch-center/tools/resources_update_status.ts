import { tool } from "@alexkroman1/aai";
import { z } from "zod";
import type { KV } from "../shared.ts";
import { getState, now, recalculateAlertLevel, saveState } from "../shared.ts";

export const resourcesUpdateStatus = tool({
  description: "Update a resource unit's status when it radios in.",
  parameters: z.object({
    callsign: z.string().describe("The resource callsign"),
    status: z
      .enum(["available", "dispatched", "en_route", "on_scene", "returning"])
      .describe("New status"),
    notes: z.string().describe("Status notes").optional(),
  }),
  async execute(args, ctx: { kv: KV }) {
    const state = await getState(ctx.kv);
    const resource = state.resources.find(
      (r) => r.callsign.toLowerCase() === args.callsign.toLowerCase(),
    );
    if (!resource) {
      return { error: `Resource ${args.callsign} not found` };
    }

    const previousStatus = resource.status;
    resource.status = args.status;

    if (args.status === "available") {
      resource.assignedIncident = null;
      resource.eta = null;
    }

    // Log to incident timeline if assigned
    if (resource.assignedIncident) {
      const inc = state.incidents[resource.assignedIncident];
      if (inc) {
        inc.timeline.push({
          time: now(),
          event: `${args.callsign}: ${previousStatus} → ${args.status}${args.notes ? ` (${args.notes})` : ""}`,
        });
        inc.updatedAt = now();
      }
    }

    recalculateAlertLevel(state);
    await saveState(ctx.kv, state);

    return {
      callsign: resource.callsign,
      previousStatus,
      newStatus: args.status,
      assignedIncident: resource.assignedIncident,
      systemAlertLevel: state.alertLevel,
    };
  },
});
