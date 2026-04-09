import type { IncidentType, Severity } from "../_shared.ts";
import { getApplicableProtocols } from "../_shared.ts";

export const description =
  "Look up step-by-step response protocols for a given incident type and severity.";

export const parameters = {
  type: "object",
  properties: {
    incidentType: {
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
      description: "Type of incident",
    },
    severity: {
      type: "string",
      enum: ["critical", "urgent", "moderate", "minor"],
      description: "Severity level",
    },
  },
  required: ["incidentType", "severity"],
};

export default async function execute(
  args: { incidentType: IncidentType; severity: Severity },
  _ctx: unknown,
) {
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
}
