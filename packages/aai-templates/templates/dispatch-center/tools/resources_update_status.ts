import { tool } from "@alexkroman1/aai";
import { z } from "zod";
import { dispatchSlot, logEvent, RESOURCE_STATUSES } from "../shared.ts";

export const resourcesUpdateStatus = tool({
  description: "Update a resource unit's status when it radios in.",
  inputSchema: z.object({
    callsign: z.string().max(50).describe("The resource callsign"),
    status: z.enum(RESOURCE_STATUSES).describe("New status"),
    notes: z.string().max(1000).describe("Status notes").optional(),
  }),
  async execute(args, ctx) {
    return dispatchSlot.update(ctx, (state) => {
      const resource = state.resources.find(
        (r) => r.callsign.toLowerCase() === args.callsign.toLowerCase(),
      );
      if (!resource) {
        return { error: `Resource ${args.callsign} not found` };
      }

      const previousStatus = resource.status;

      // Log to the incident timeline BEFORE unassigning, so the
      // return-to-available transition is recorded too.
      if (resource.assignedIncident) {
        const inc = state.incidents[resource.assignedIncident];
        if (inc) {
          logEvent(
            inc,
            `${resource.callsign}: ${previousStatus} → ${args.status}${args.notes ? ` (${args.notes})` : ""}`,
          );
        }
      }

      resource.status = args.status;

      if (args.status === "available") {
        // Detach from the old incident on BOTH sides — leaving the id in
        // assignedResources lets that incident later yank a unit that has
        // been re-dispatched elsewhere.
        if (resource.assignedIncident) {
          const inc = state.incidents[resource.assignedIncident];
          if (inc) {
            inc.assignedResources = inc.assignedResources.filter((id) => id !== resource.id);
          }
        }
        resource.assignedIncident = null;
        resource.eta = null;
      }
      if (args.status === "on_scene") {
        resource.eta = null;
      }

      return {
        callsign: resource.callsign,
        previousStatus,
        newStatus: args.status,
        assignedIncident: resource.assignedIncident,
      };
    });
  },
});
