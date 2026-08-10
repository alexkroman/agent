import { isToolFailure, tool } from "@alexkroman1/aai";
import { z } from "zod";
import { assertNotResolved, dispatchSlot, findIncident, logEvent } from "../shared.ts";

export const incidentUpdateStatus = tool({
  description: "Update an incident's status (en_route, on_scene, resolved, escalated).",
  inputSchema: z.object({
    incidentId: z.string().max(20).describe("The incident ID"),
    status: z.enum(["en_route", "on_scene", "resolved", "escalated"]).describe("New status"),
    notes: z.string().max(1000).describe("Status update notes").optional(),
    casualtyUpdate: z
      .object({
        confirmed: z.number().int().nonnegative().optional(),
        treated: z.number().int().nonnegative().optional(),
      })
      .describe("Updated casualty numbers")
      .optional(),
  }),
  async execute(args, ctx) {
    return dispatchSlot.update(ctx, (state) => {
      const inc = findIncident(state, args.incidentId);
      if (isToolFailure(inc)) return inc;
      const blocked = assertNotResolved(inc, `set status to ${args.status}`);
      if (blocked) return blocked;

      inc.status = args.status;
      logEvent(inc, `Status → ${args.status}${args.notes ? `: ${args.notes}` : ""}`);

      if (args.casualtyUpdate) {
        if (args.casualtyUpdate.confirmed !== undefined) {
          inc.casualties.confirmed = args.casualtyUpdate.confirmed;
        }
        if (args.casualtyUpdate.treated !== undefined) {
          inc.casualties.treated = args.casualtyUpdate.treated;
        }
      }

      // Only touch resources still assigned to THIS incident — a unit that
      // radioed available and was re-dispatched elsewhere belongs to its
      // new incident now.
      const ownResources = state.resources.filter((r) => r.assignedIncident === inc.id);

      if (args.status === "resolved") {
        for (const r of ownResources) {
          r.status = "returning";
          r.assignedIncident = null;
          r.eta = null;
        }
        inc.assignedResources = [];
        logEvent(inc, "All resources released — incident closed");
      }

      if (args.status === "en_route" || args.status === "on_scene") {
        for (const r of ownResources) {
          r.status = args.status;
          if (args.status === "on_scene") r.eta = null;
        }
      }

      return {
        incidentId: args.incidentId,
        newStatus: args.status,
        timeline: inc.timeline.slice(-5).map((t) => t.event),
        casualties: inc.casualties,
      };
    });
  },
});
