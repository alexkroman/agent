import { tool } from "@alexkroman1/aai";
import { z } from "zod";
import { getApplicableProtocols, INCIDENT_TYPES, SEVERITIES } from "../shared.ts";

export const opsProtocols = tool({
  description: "Look up step-by-step response protocols for a given incident type and severity.",
  parameters: z.object({
    incidentType: z.enum(INCIDENT_TYPES).describe("Type of incident"),
    severity: z.enum(SEVERITIES).describe("Severity level"),
  }),
  async execute(args) {
    const protocols = getApplicableProtocols(args.incidentType, args.severity);
    if (protocols.length === 0) {
      return {
        message: "No specific protocols for this combination. Use standard operating procedures.",
        protocols: [],
      };
    }
    return {
      protocols: protocols.map((p) => ({
        name: p.name,
        steps: p.steps,
        requiredResources: p.requiredResources,
      })),
    };
  },
});
