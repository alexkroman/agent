import { tool } from "aai";
import { z } from "zod";
import type { KV } from "../shared.ts";
import {
  calculateTriageScore,
  getApplicableProtocols,
  getState,
  now,
  recalculateAlertLevel,
  recommendResources,
  saveState,
} from "../shared.ts";

export const incidentTriage = tool({
  description:
    "Triage an incident — confirm or override severity, type, hazards, and casualty count.",
  parameters: z.object({
    incidentId: z.string().describe("The incident ID"),
    severity: z
      .enum(["critical", "urgent", "moderate", "minor"])
      .describe("Confirmed severity after triage")
      .optional(),
    type: z
      .enum([
        "medical",
        "fire",
        "hazmat",
        "traffic",
        "crime",
        "natural_disaster",
        "utility",
        "other",
      ])
      .describe("Confirmed incident type")
      .optional(),
    additionalHazards: z.array(z.string()).describe("Any additional hazards identified").optional(),
    casualtyUpdate: z.number().describe("Updated casualty count").optional(),
    notes: z.string().describe("Triage notes").optional(),
  }),
  async execute(args, ctx: { kv: KV }) {
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
  },
});
