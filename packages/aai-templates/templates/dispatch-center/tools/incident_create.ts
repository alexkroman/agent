import { z } from "zod";
import {
  calculateTriageScore,
  callFlow,
  createIncident,
  dispatchSlot,
  getApplicableProtocols,
  recommendResources,
  recommendSeverity,
  recommendType,
  resourceBrief,
} from "../shared.ts";

/**
 * **Not a `callFlow.tool`, deliberately.** A new 911 call is legal in every
 * state, so a `when` listing all of them would be a gate that gates nothing —
 * the same call `plan-and-execute`'s `start_plan` makes. It sends `LOGGED`
 * itself, which is what `flow.send` is public for, and reports the position it
 * landed in so the model reads "confirm the severity and type" as part of this
 * result rather than having to remember it from the prompt.
 *
 * The `send` sits INSIDE the board's mutation window, which is safe because it
 * is a different slot: the re-entrancy guard is per slot, and neither window
 * spans an await, so the whole call commits atomically.
 */
export default dispatchSlot.updateTool({
  description: "Create a new incident from an incoming emergency call.",
  inputSchema: z.object({
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
  execute(args, state, ctx) {
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

    const at = callFlow.send(ctx, { type: "LOGGED" });

    return {
      incidentId: id,
      at: at.state,
      next: at.instruction,
      recommendedSeverity: recSeverity,
      recommendedType: recType,
      triageScore,
      applicableProtocols: protocols.map((p) => p.name),
      recommendedResources: recommended.map(resourceBrief),
      message:
        recSeverity === "critical"
          ? `PRIORITY ONE — ${id} created. Immediate dispatch recommended. ${protocols.length} protocol(s) applicable.`
          : `${id} created. Triage score ${triageScore}. ${recommended.length} resource(s) recommended.`,
    };
  },
});
