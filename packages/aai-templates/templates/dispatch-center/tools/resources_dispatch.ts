import { isToolFailure, tool } from "@alexkroman1/aai";
import { z } from "zod";
import type { Resource } from "../shared.ts";
import {
  assertNotResolved,
  dispatchSlot,
  findIncident,
  logEvent,
  recommendResources,
} from "../shared.ts";

export default tool({
  description:
    "Dispatch units to an incident. Can auto-dispatch recommended resources or manually specify callsigns.",
  inputSchema: z.object({
    incidentId: z.string().max(20).describe("The incident ID"),
    callsigns: z
      .array(z.string().max(50))
      .max(20)
      .describe(
        "Resource callsigns to dispatch, or the single entry 'auto' for system-recommended resources.",
      )
      .optional(),
    autoDispatch: z
      .boolean()
      .describe("If true, automatically dispatch recommended resources")
      .optional(),
    priority: z
      .enum(["routine", "priority", "emergency"])
      .describe("Dispatch priority — affects simulated ETA")
      .optional(),
  }),
  async execute(args, ctx) {
    return dispatchSlot.update(ctx, (state) => {
      const inc = findIncident(state, args.incidentId);
      if (isToolFailure(inc)) return inc;
      const blocked = assertNotResolved(inc, "dispatch resources");
      if (blocked) return blocked;

      const dispatched: { callsign: string; type: string; eta: number }[] = [];
      const failed: { callsign: string; reason: string }[] = [];

      // The literal "auto" callsign means the same thing as autoDispatch.
      const wantsAuto =
        args.autoDispatch || args.callsigns?.some((cs) => cs.toLowerCase() === "auto");

      let resourcesToDispatch: Resource[] = [];

      if (wantsAuto) {
        resourcesToDispatch = recommendResources(inc.type, inc.severity, state);
      } else if (args.callsigns) {
        for (const cs of args.callsigns) {
          const r = state.resources.find((r) => r.callsign.toLowerCase() === cs.toLowerCase());
          if (!r) {
            failed.push({ callsign: cs, reason: "Not found" });
            continue;
          }
          if (r.status !== "available") {
            failed.push({ callsign: cs, reason: `Currently ${r.status}` });
            continue;
          }
          resourcesToDispatch.push(r);
        }
      }

      const etaBase = args.priority === "emergency" ? 3 : args.priority === "priority" ? 6 : 10;

      for (const r of resourcesToDispatch) {
        const eta = etaBase + Math.floor(Math.random() * 5);
        r.status = "dispatched";
        r.assignedIncident = args.incidentId;
        r.eta = eta;
        inc.assignedResources.push(r.id);
        dispatched.push({ callsign: r.callsign, type: r.type, eta });
        logEvent(inc, `Dispatched ${r.callsign} — ETA ${eta} min`);
      }

      if (dispatched.length > 0) {
        inc.status = "dispatched";
      }

      const availableCount = state.resources.filter((r) => r.status === "available").length;

      return {
        incidentId: args.incidentId,
        dispatched,
        failed: failed.length > 0 ? failed : undefined,
        totalAssignedToIncident: inc.assignedResources.length,
        remainingAvailableResources: availableCount,
        capacityWarning:
          availableCount <= 3
            ? "WARNING: Resource capacity critically low. Consider mutual aid."
            : undefined,
      };
    });
  },
});
