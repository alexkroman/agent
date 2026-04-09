import type { IncidentType, KV, Severity } from "../_shared.ts";
import {
  calculateTriageScore,
  getApplicableProtocols,
  getState,
  now,
  recalculateAlertLevel,
  recommendResources,
  saveState,
} from "../_shared.ts";

export const description =
  "Triage an incident — confirm or override severity, type, hazards, and casualty count.";

export const parameters = {
  type: "object",
  properties: {
    incidentId: { type: "string", description: "The incident ID" },
    severity: {
      type: "string",
      enum: ["critical", "urgent", "moderate", "minor"],
      description: "Confirmed severity after triage",
    },
    type: {
      type: "string",
      enum: [
        "medical",
        "fire",
        "hazmat",
        "traffic",
        "crime",
        "natural_disaster",
        "utility",
        "other",
      ],
      description: "Confirmed incident type",
    },
    additionalHazards: {
      type: "array",
      items: { type: "string" },
      description: "Any additional hazards identified",
    },
    casualtyUpdate: { type: "number", description: "Updated casualty count" },
    notes: { type: "string", description: "Triage notes" },
  },
  required: ["incidentId"],
};

export default async function execute(
  args: {
    incidentId: string;
    severity?: Severity;
    type?: IncidentType;
    additionalHazards?: string[];
    casualtyUpdate?: number;
    notes?: string;
  },
  ctx: { kv: KV },
) {
  const state = await getState(ctx.kv);
  const inc = state.incidents[args.incidentId];
  if (!inc) return { error: `Incident ${args.incidentId} not found` };

  if (args.severity) inc.severity = args.severity;
  if (args.type) inc.type = args.type;
  if (args.additionalHazards) inc.hazards.push(...args.additionalHazards);
  if (args.casualtyUpdate !== undefined) {
    inc.casualties.estimated = args.casualtyUpdate;
  }
  if (args.notes) inc.notes.push(args.notes);

  inc.triageScore = calculateTriageScore(
    inc.severity,
    inc.type,
    inc.casualties.estimated,
    inc.hazards.length,
  );
  inc.status = "triaged";
  inc.updatedAt = now();
  inc.timeline.push({
    time: now(),
    event: `Triaged: ${inc.severity} ${inc.type}, score ${inc.triageScore}`,
  });

  recalculateAlertLevel(state);
  await saveState(ctx.kv, state);

  const protocols = getApplicableProtocols(inc.type, inc.severity);
  const recommended = recommendResources(inc.type, inc.severity, state);

  return {
    incidentId: args.incidentId,
    severity: inc.severity,
    type: inc.type,
    triageScore: inc.triageScore,
    hazards: inc.hazards,
    estimatedCasualties: inc.casualties.estimated,
    protocols: protocols.map((p) => ({
      name: p.name,
      steps: p.steps,
      requiredResources: p.requiredResources,
    })),
    recommendedResources: recommended.map((r) => ({
      callsign: r.callsign,
      type: r.type,
    })),
    systemAlertLevel: state.alertLevel,
  };
}
