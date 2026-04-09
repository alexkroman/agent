import type { KV } from "../_shared.ts";
import { getApplicableProtocols, getState, now } from "../_shared.ts";

export const description =
  "Get full details on a specific incident including timeline and assigned resources.";

export const parameters = {
  type: "object",
  properties: {
    incidentId: { type: "string", description: "The incident ID" },
  },
  required: ["incidentId"],
};

export default async function execute(args: { incidentId: string }, ctx: { kv: KV }) {
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
}
