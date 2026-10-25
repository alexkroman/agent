import { z } from "zod";
import {
  calculateTriageScore,
  callFlow,
  dispatchSlot,
  getApplicableProtocols,
  INCIDENT_TYPES,
  logEvent,
  recommendResources,
  requireIncident,
  SEVERITIES,
} from "../shared.ts";

/**
 * Gated on `working`: there is nothing to triage until something has been
 * logged, and the flow's refusal says so in the dispatcher's own terms.
 * `TRIAGED` moves the call to `dispatching`, whose instruction is "assign
 * units", so the sequencing arrives in this tool's own result.
 */
export default dispatchSlot.updateTool({
  description:
    "Triage an incident — confirm or override severity, type, hazards, and casualty count.",
  dialog: callFlow,
  when: "working",
  send: { type: "TRIAGED" },
  inputSchema: z.object({
    incidentId: z.string().max(20).describe("The incident ID"),
    severity: z.enum(SEVERITIES).describe("Confirmed severity after triage").optional(),
    type: z.enum(INCIDENT_TYPES).describe("Confirmed incident type").optional(),
    additionalHazards: z
      .array(z.string().max(100))
      .max(20)
      .describe("Any additional hazards identified")
      .optional(),
    casualtyUpdate: z.number().int().nonnegative().describe("Updated casualty count").optional(),
    notes: z.string().max(1000).describe("Triage notes").optional(),
  }),
  require: (state, { incidentId }) => requireIncident(state, incidentId, "triage"),
  execute(args, state, ctx) {
    const inc = state.incidents[args.incidentId]!;

    if (args.severity) inc.severity = args.severity;
    if (args.type) inc.type = args.type;
    for (const hazard of args.additionalHazards ?? []) {
      if (!inc.hazards.includes(hazard)) inc.hazards.push(hazard);
    }
    if (args.casualtyUpdate !== undefined) inc.casualties.estimated = args.casualtyUpdate;
    if (args.notes) logEvent(inc, `Triage note: ${args.notes}`, ctx.now());

    inc.triageScore = calculateTriageScore(
      inc.severity,
      inc.type,
      inc.casualties.estimated,
      inc.hazards.length,
    );
    inc.status = "triaged";
    logEvent(inc, `Triaged: ${inc.severity} ${inc.type}, score ${inc.triageScore}`, ctx.now());

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
      recommendedResources: recommended.map((r) => ({ callsign: r.callsign, type: r.type })),
    };
  },
});
