import { tool } from "@alexkroman1/aai";
import { z } from "zod";
import {
  calculateTriageScore,
  createIncident,
  getApplicableProtocols,
  recommendResources,
  recommendSeverity,
  recommendType,
  updateState,
} from "../shared.ts";

export const incidentCreate = tool({
  description: "Create a new incident from an incoming emergency call.",
  parameters: z.object({
    location: z.string().max(300).describe("Address or location description"),
    description: z.string().max(2000).describe("Nature of the emergency as described by caller"),
    callerName: z.string().max(120).describe("Caller's name").optional(),
    callerPhone: z.string().max(40).describe("Callback number").optional(),
    estimatedCasualties: z
      .number()
      .int()
      .nonnegative()
      .describe("Estimated number of casualties if known")
      .optional(),
    hazards: z
      .array(z.string().max(100))
      .max(20)
      .describe("Known hazards: fire, chemical, electrical, structural, weapons")
      .optional(),
  }),
  async execute(args, ctx) {
    return updateState(ctx, (state) => {
      const recSeverity = recommendSeverity(args.description);
      const recType = recommendType(args.description);
      const triageScore = calculateTriageScore(
        recSeverity,
        recType,
        args.estimatedCasualties ?? 0,
        args.hazards?.length ?? 0,
      );

      const incident = createIncident(state, {
        type: recType,
        severity: recSeverity,
        location: args.location,
        description: args.description,
        callerName: args.callerName ?? "Unknown",
        callerPhone: args.callerPhone ?? "Unknown",
        triageScore,
        timeline: [{ time: Date.now(), event: `Incident created: ${args.description}` }],
        casualties: {
          confirmed: 0,
          estimated: args.estimatedCasualties ?? 0,
          treated: 0,
        },
        hazards: args.hazards ?? [],
      });
      const id = incident.id;

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
        message:
          recSeverity === "critical"
            ? `PRIORITY ONE — ${id} created. Immediate dispatch recommended. ${protocols.length} protocol(s) applicable.`
            : `${id} created. Triage score ${triageScore}. ${recommended.length} resource(s) recommended.`,
      };
    });
  },
});
