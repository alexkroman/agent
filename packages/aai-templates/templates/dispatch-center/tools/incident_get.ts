import { isToolFailure, tool } from "@alexkroman1/aai";
import { z } from "zod";
import {
  dispatchSlot,
  findIncident,
  getApplicableProtocols,
  incidentAgeMinutes,
} from "../shared.ts";

export const incidentGet = tool({
  description: "Get full details on a specific incident including timeline and assigned resources.",
  inputSchema: z.object({
    incidentId: z.string().max(20).describe("The incident ID"),
  }),
  async execute(args, ctx) {
    const state = dispatchSlot.get(ctx);
    const inc = findIncident(state, args.incidentId);
    if (isToolFailure(inc)) return inc;

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

    return {
      ...inc,
      ageMinutes: incidentAgeMinutes(inc),
      assignedResourceDetails,
      applicableProtocols: getApplicableProtocols(inc.type, inc.severity).map((p) => p.name),
    };
  },
});
