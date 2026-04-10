import { tool } from "aai";
import { z } from "zod";
import type { KV, Resource } from "../_shared.ts";
import { getState, now, recalculateAlertLevel, recommendResources, saveState } from "../_shared.ts";

export const resourcesDispatch = tool({
  description:
    "Dispatch units to an incident. Can auto-dispatch recommended resources or manually specify callsigns.",
  parameters: z.object({
    incidentId: z.string().describe("The incident ID"),
    callsigns: z
      .array(z.string())
      .describe("Resource callsigns to dispatch. Use 'auto' for system-recommended resources.")
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
  async execute(args, ctx: { kv: KV }) {
    const state = await getState(ctx.kv);
    const inc = state.incidents[args.incidentId];
    if (!inc) return { error: `Incident ${args.incidentId} not found` };

    const dispatched: {
      callsign: string;
      type: string;
      eta: number;
    }[] = [];
    const failed: { callsign: string; reason: string }[] = [];

    let resourcesToDispatch: Resource[] = [];

    if (args.autoDispatch) {
      resourcesToDispatch = recommendResources(inc.type, inc.severity, state);
    } else if (args.callsigns) {
      for (const cs of args.callsigns) {
        const r = state.resources.find((r) => r.callsign.toLowerCase() === cs.toLowerCase());
        if (!r) {
          failed.push({ callsign: cs, reason: "Not found" });
          continue;
        }
        if (r.status !== "available") {
          failed.push({
            callsign: cs,
            reason: `Currently ${r.status}`,
          });
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
      inc.timeline.push({
        time: now(),
        event: `Dispatched ${r.callsign} — ETA ${eta} min`,
      });
    }

    if (dispatched.length > 0) {
      inc.status = "dispatched";
      inc.updatedAt = now();
    }

    recalculateAlertLevel(state);
    await saveState(ctx.kv, state);

    const availableCount = state.resources.filter((r) => r.status === "available").length;

    return {
      incidentId: args.incidentId,
      dispatched,
      failed: failed.length > 0 ? failed : undefined,
      totalAssignedToIncident: inc.assignedResources.length,
      remainingAvailableResources: availableCount,
      systemAlertLevel: state.alertLevel,
      capacityWarning:
        availableCount <= 3
          ? "WARNING: Resource capacity critically low. Consider mutual aid."
          : undefined,
    };
  },
});
