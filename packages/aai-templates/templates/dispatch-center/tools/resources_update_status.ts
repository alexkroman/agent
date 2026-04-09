import type { KV, Resource } from "../_shared.ts";
import { getState, now, recalculateAlertLevel, saveState } from "../_shared.ts";

export default async function execute(
  args: {
    callsign: string;
    status: Resource["status"];
    notes?: string;
  },
  ctx: { kv: KV },
) {
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
}
