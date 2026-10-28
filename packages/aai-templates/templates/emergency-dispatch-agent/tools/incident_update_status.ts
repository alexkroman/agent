import { z } from "zod";
import { callFlow, dispatchSlot, logEvent, requireIncident } from "../shared.ts";

/**
 * Gated on `working`; sends nothing. A status update moves the INCIDENT, not
 * the call — closing one incident says nothing about the others on the board.
 */
export default dispatchSlot.updateTool({
  effect: "write",
  description: "Update an incident's status (en_route, on_scene, resolved, escalated).",
  dialog: callFlow,
  when: "working",
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
  require: (state, { incidentId, status }) =>
    requireIncident(state, incidentId, `set status to ${status}`),
  execute(args, state, ctx) {
    const inc = state.incidents[args.incidentId]!;

    inc.status = args.status;
    logEvent(inc, `Status → ${args.status}${args.notes ? `: ${args.notes}` : ""}`, ctx.now());

    if (args.casualtyUpdate?.confirmed !== undefined) {
      inc.casualties.confirmed = args.casualtyUpdate.confirmed;
    }
    if (args.casualtyUpdate?.treated !== undefined) {
      inc.casualties.treated = args.casualtyUpdate.treated;
    }

    // Only touch resources still assigned to THIS incident — a unit that
    // radioed available and was re-dispatched elsewhere belongs to its new
    // incident now.
    const ownResources = state.resources.filter((r) => r.assignedIncident === inc.id);

    if (args.status === "resolved") {
      for (const r of ownResources) {
        r.status = "returning";
        r.assignedIncident = null;
        r.eta = null;
      }
      inc.assignedResources = [];
      logEvent(inc, "All resources released — incident closed", ctx.now());
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
  },
});
