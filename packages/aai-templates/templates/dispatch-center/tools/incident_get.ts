import { tool } from "@alexkroman1/aai";
import { z } from "zod";
import { findIncident, getApplicableProtocols, getState } from "../shared.ts";

export const incidentGet = tool({
  description: "Get full details on a specific incident including timeline and assigned resources.",
  parameters: z.object({
    incidentId: z.string().max(20).describe("The incident ID"),
  }),
  async execute(args, ctx) {
    const state = getState(ctx);
    const inc = findIncident(state, args.incidentId);
    if ("error" in inc) return inc;

    const assignedResourceDetails = inc.assignedResources
      .map((rId) => {
        const r = state.resources.find((r) => r.id === rId);
        return r
          ? {
              callsign: r.callsign,
              type: r.type,
              status: r.status,
              eta: r.eta,
            }
          : null;
      })
      .filter(Boolean);

    const ageMinutes = Math.round((Date.now() - inc.createdAt) / 60_000);

    return {
      ...inc,
      ageMinutes,
      assignedResourceDetails,
      applicableProtocols: getApplicableProtocols(inc.type, inc.severity).map((p) => p.name),
    };
  },
});
