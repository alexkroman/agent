import { tool } from "aai";
import { z } from "zod";
import type { IncidentType, Severity } from "../shared.ts";
import { getApplicableProtocols } from "../shared.ts";

export const opsProtocols = tool({
  description: "Look up step-by-step response protocols for a given incident type and severity.",
  parameters: z.object({
    incidentType: z
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
      .describe("Type of incident"),
    severity: z.enum(["critical", "urgent", "moderate", "minor"]).describe("Severity level"),
  }),
  async execute(args) {
    const protocols = getApplicableProtocols(
      args.incidentType as IncidentType,
      args.severity as Severity,
    );
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
