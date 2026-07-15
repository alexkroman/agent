import { tool } from "@alexkroman1/aai";
import { z } from "zod";
import {
  calculateTriageScore,
  findIncident,
  getApplicableProtocols,
  getState,
  INCIDENT_TYPES,
  recalculateAlertLevel,
  recommendResources,
  SEVERITIES,
  saveState,
} from "../shared.ts";

export const incidentTriage = tool({
  description:
    "Triage an incident — confirm or override severity, type, hazards, and casualty count.",
  parameters: z.object({
    incidentId: z.string().describe("The incident ID"),
    severity: z.enum(SEVERITIES).describe("Confirmed severity after triage").optional(),
    type: z.enum(INCIDENT_TYPES).describe("Confirmed incident type").optional(),
    additionalHazards: z.array(z.string()).describe("Any additional hazards identified").optional(),
    casualtyUpdate: z.number().describe("Updated casualty count").optional(),
    notes: z.string().describe("Triage notes").optional(),
  }),
  async execute(args, ctx) {
    const state = await getState(ctx.kv);
    const inc = findIncident(state, args.incidentId);
    if ("error" in inc) return inc;

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
    inc.updatedAt = Date.now();
    inc.timeline.push({
      time: Date.now(),
      event: `Triaged: ${inc.severity} ${inc.type}, score ${inc.triageScore}`,
    });

    recalculateAlertLevel(state);
    await saveState(ctx.kv, state);

    const protocols = getApplicableProtocols(inc.type, inc.severity);
    const recommended = recommendResources(inc.type, inc.severity, state);

    const result = {
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
      incident: inc,
      systemAlertLevel: state.alertLevel,
    };
    ctx.send("incidents", result);
    return result;
  },
});
