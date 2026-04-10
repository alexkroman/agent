import { tool } from "aai";
import { z } from "zod";
import type { KV } from "../shared.ts";
import { getApplicableProtocols, getState, now } from "../shared.ts";

export const incidentGet = tool({
  description: "Get full details on a specific incident including timeline and assigned resources.",
  parameters: z.object({
    incidentId: z.string().describe("The incident ID"),
  }),
  async execute(args, ctx: { kv: KV }) {
    const state = await getState(ctx.kv);
    const inc = state.incidents[args.incidentId];
    if (!inc) return { error: `Incident ${args.incidentId} not found` };

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

    const ageMinutes = Math.round((now() - inc.createdAt) / 60_000);

    return {
      ...inc,
      ageMinutes,
      assignedResourceDetails,
      applicableProtocols: getApplicableProtocols(inc.type, inc.severity).map((p) => p.name),
    };
  },
});
