import type { KV, Severity } from "../_shared.ts";
import {
  calculateTriageScore,
  getState,
  now,
  recalculateAlertLevel,
  recommendResources,
  saveState,
} from "../_shared.ts";

export default async function execute(
  args: {
    incidentId: string;
    reason: string;
    requestMutualAid?: boolean;
    newSeverity?: Severity;
  },
  ctx: { kv: KV },
) {
  const state = await getState(ctx.kv);
  const inc = state.incidents[args.incidentId];
  if (!inc) return { error: `Incident ${args.incidentId} not found` };

  inc.escalationLevel++;
  if (args.newSeverity) inc.severity = args.newSeverity;
  inc.status = "escalated";
  inc.updatedAt = now();
  inc.timeline.push({
    time: now(),
    event: `ESCALATED (Level ${inc.escalationLevel}): ${args.reason}`,
  });
  inc.notes.push(`Escalation: ${args.reason}`);

  if (args.requestMutualAid) {
    state.mutualAidRequested = true;
    inc.timeline.push({
      time: now(),
      event: "Mutual aid requested from neighboring jurisdictions",
    });
    state.resources.push(
      {
        id: `MA-${Date.now()}-1`,
        type: "ambulance",
        callsign: "Mutual-Aid-Medic",
        status: "available",
        assignedIncident: null,
        eta: null,
        capabilities: ["als"],
      },
      {
        id: `MA-${Date.now()}-2`,
        type: "fire_engine",
        callsign: "Mutual-Aid-Engine",
        status: "available",
        assignedIncident: null,
        eta: null,
        capabilities: ["structural"],
      },
    );
  }

  inc.triageScore = calculateTriageScore(
    inc.severity,
    inc.type,
    inc.casualties.estimated,
    inc.hazards.length,
  );
  recalculateAlertLevel(state);
  await saveState(ctx.kv, state);

  const additionalResources = recommendResources(inc.type, inc.severity, state).filter(
    (r) => !inc.assignedResources.includes(r.id),
  );

  return {
    incidentId: args.incidentId,
    escalationLevel: inc.escalationLevel,
    newSeverity: inc.severity,
    newTriageScore: inc.triageScore,
    mutualAidRequested: args.requestMutualAid,
    additionalResourcesAvailable: additionalResources.map((r) => ({
      callsign: r.callsign,
      type: r.type,
    })),
    systemAlertLevel: state.alertLevel,
    message: `ESCALATION CONFIRMED — ${args.incidentId} now Level ${inc.escalationLevel}. ${additionalResources.length} additional resource(s) available for dispatch.`,
  };
}
