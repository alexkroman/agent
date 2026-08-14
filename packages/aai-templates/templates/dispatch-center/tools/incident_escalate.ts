import { isToolFailure, tool } from "@alexkroman1/aai";
import { z } from "zod";
import {
  assertNotResolved,
  calculateTriageScore,
  dispatchSlot,
  findIncident,
  logEvent,
  recommendResources,
} from "../shared.ts";

export default tool({
  description: "Escalate an incident when it exceeds current capacity or severity increases.",
  inputSchema: z.object({
    incidentId: z.string().max(20).describe("The incident ID"),
    reason: z.string().max(1000).describe("Reason for escalation"),
    requestMutualAid: z
      .boolean()
      .describe("Whether to request mutual aid from neighboring jurisdictions")
      .optional(),
    newSeverity: z.enum(["critical", "urgent"]).describe("Escalated severity level").optional(),
  }),
  async execute(args, ctx) {
    return dispatchSlot.update(ctx, (state) => {
      const inc = findIncident(state, args.incidentId);
      if (isToolFailure(inc)) return inc;
      const blocked = assertNotResolved(inc, "escalate");
      if (blocked) return blocked;

      inc.escalationLevel++;
      if (args.newSeverity) inc.severity = args.newSeverity;
      inc.status = "escalated";
      logEvent(inc, `ESCALATED (Level ${inc.escalationLevel}): ${args.reason}`);

      if (args.requestMutualAid) {
        logEvent(inc, "Mutual aid requested from neighboring jurisdictions");
        // Counter-based ids/callsigns: Date.now() collides across rapid
        // escalations, and duplicate callsigns break dispatch-by-callsign.
        const medicN = ++state.mutualAidCounter;
        const engineN = ++state.mutualAidCounter;
        state.resources.push(
          {
            id: `MA-${medicN}`,
            type: "ambulance",
            callsign: `Mutual-Aid-Medic-${medicN}`,
            status: "available",
            assignedIncident: null,
            eta: null,
            capabilities: ["als"],
          },
          {
            id: `MA-${engineN}`,
            type: "fire_engine",
            callsign: `Mutual-Aid-Engine-${engineN}`,
            status: "available",
            assignedIncident: null,
            eta: null,
            capabilities: ["structural"],
          },
        );
      }

      inc.triageScore = calculateTriageScore(
        inc.severity,
        inc.type,
        inc.casualties.estimated,
        inc.hazards.length,
      );

      const additionalResources = recommendResources(inc.type, inc.severity, state).filter(
        (r) => !inc.assignedResources.includes(r.id),
      );

      return {
        incidentId: args.incidentId,
        escalationLevel: inc.escalationLevel,
        newSeverity: inc.severity,
        newTriageScore: inc.triageScore,
        mutualAidRequested: args.requestMutualAid ?? false,
        additionalResourcesAvailable: additionalResources.map((r) => ({
          callsign: r.callsign,
          type: r.type,
        })),
        message: `ESCALATION CONFIRMED — ${args.incidentId} now Level ${inc.escalationLevel}. ${additionalResources.length} additional resource(s) available for dispatch.`,
      };
    });
  },
});
