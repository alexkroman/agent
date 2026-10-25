import { z } from "zod";
import {
  dispatchSlot,
  getApplicableProtocols,
  incidentAgeMinutes,
  requireIncident,
} from "../shared.ts";

export default dispatchSlot.tool({
  description: "Get full details on a specific incident including timeline and assigned resources.",
  inputSchema: z.object({
    incidentId: z.string().max(20).describe("The incident ID"),
  }),
  require: (state, { incidentId }) => requireIncident(state, incidentId),
  execute(args, state, ctx) {
    const inc = state.incidents[args.incidentId]!;
    const assignedResourceDetails = inc.assignedResources
      .map((rId) => {
        const r = state.resources.find((r) => r.id === rId);
        return r ? { callsign: r.callsign, type: r.type, status: r.status, eta: r.eta } : null;
      })
      .filter(Boolean);

    return {
      ...inc,
      ageMinutes: incidentAgeMinutes(inc, ctx.now()),
      assignedResourceDetails,
      applicableProtocols: getApplicableProtocols(inc.type, inc.severity).map((p) => p.name),
    };
  },
});
