import type { Incident, KV } from "../_shared.ts";
import {
  calculateTriageScore,
  getApplicableProtocols,
  getState,
  now,
  recalculateAlertLevel,
  recommendResources,
  recommendSeverity,
  recommendType,
  saveIncidentSnapshot,
  saveState,
} from "../_shared.ts";

export const description = "Create a new incident from an incoming emergency call.";

export const parameters = {
  type: "object",
  properties: {
    location: { type: "string", description: "Address or location description" },
    description: { type: "string", description: "Nature of the emergency as described by caller" },
    callerName: { type: "string", description: "Caller's name" },
    callerPhone: { type: "string", description: "Callback number" },
    estimatedCasualties: {
      type: "number",
      description: "Estimated number of casualties if known",
    },
    hazards: {
      type: "array",
      items: { type: "string" },
      description: "Known hazards: fire, chemical, electrical, structural, weapons",
    },
  },
  required: ["location", "description"],
};

export default async function execute(
  args: {
    location: string;
    description: string;
    callerName?: string;
    callerPhone?: string;
    estimatedCasualties?: number;
    hazards?: string[];
  },
  ctx: { kv: KV },
) {
  const state = await getState(ctx.kv);
  state.incidentCounter++;
  const id = `INC-${String(state.incidentCounter).padStart(4, "0")}`;

  const recSeverity = recommendSeverity(args.description);
  const recType = recommendType(args.description);
  const triageScore = calculateTriageScore(
    recSeverity,
    recType,
    args.estimatedCasualties ?? 0,
    args.hazards?.length ?? 0,
  );

  const incident: Incident = {
    id,
    type: recType,
    severity: recSeverity,
    status: "incoming",
    location: args.location,
    description: args.description,
    callerName: args.callerName ?? "Unknown",
    callerPhone: args.callerPhone ?? "Unknown",
    triageScore,
    assignedResources: [],
    timeline: [
      {
        time: now(),
        event: `Incident created: ${args.description}`,
      },
    ],
    notes: [],
    createdAt: now(),
    updatedAt: now(),
    escalationLevel: 0,
    protocolsActivated: [],
    casualties: {
      confirmed: 0,
      estimated: args.estimatedCasualties ?? 0,
      treated: 0,
    },
    hazards: args.hazards ?? [],
  };

  state.incidents[id] = incident;
  recalculateAlertLevel(state);
  await saveState(ctx.kv, state);
  await saveIncidentSnapshot(ctx.kv, incident);

  const protocols = getApplicableProtocols(recType, recSeverity);
  const recommended = recommendResources(recType, recSeverity, state);

  return {
    incidentId: id,
    recommendedSeverity: recSeverity,
    recommendedType: recType,
    triageScore,
    applicableProtocols: protocols.map((p) => p.name),
    recommendedResources: recommended.map((r) => ({
      callsign: r.callsign,
      type: r.type,
      capabilities: r.capabilities,
    })),
    systemAlertLevel: state.alertLevel,
    message:
      recSeverity === "critical"
        ? `PRIORITY ONE — ${id} created. Immediate dispatch recommended. ${protocols.length} protocol(s) applicable.`
        : `${id} created. Triage score ${triageScore}. ${recommended.length} resource(s) recommended.`,
  };
}
