import type { IncidentType, Severity } from "../_shared.ts";
import { getApplicableProtocols } from "../_shared.ts";

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
