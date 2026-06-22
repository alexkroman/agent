import { tool } from "@alexkroman1/aai";
import { z } from "zod";
import type { DispatchState, Incident, KV } from "../shared.ts";
import {
  deleteIncidentSnapshot,
  getState,
  now,
  recalculateAlertLevel,
  saveState,
} from "../shared.ts";

function applyCasualtyUpdate(
  inc: Incident,
  casualtyUpdate: { confirmed?: number | undefined; treated?: number | undefined },
) {
  if (casualtyUpdate.confirmed !== undefined) {
    inc.casualties.confirmed = casualtyUpdate.confirmed;
  }
  if (casualtyUpdate.treated !== undefined) {
    inc.casualties.treated = casualtyUpdate.treated;
  }
}

async function releaseResourcesOnResolution(
  kv: KV,
  state: DispatchState,
  inc: Incident,
  incidentId: string,
) {
  for (const rId of inc.assignedResources) {
    const r = state.resources.find((res) => res.id === rId);
    if (r) {
      r.status = "returning";
      r.assignedIncident = null;
      r.eta = null;
      // Auto-return to available after a delay (simulated)
      setTimeout(() => {
        r.status = "available";
      }, 2000);
    }
  }
  inc.timeline.push({
    time: now(),
    event: "All resources released — incident closed",
  });
  await deleteIncidentSnapshot(kv, incidentId);
}

function updateResourceStatuses(
  state: DispatchState,
  inc: Incident,
  status: "en_route" | "on_scene",
) {
  for (const rId of inc.assignedResources) {
    const r = state.resources.find((res) => res.id === rId);
    if (r) r.status = status;
  }
}

export const incidentUpdateStatus = tool({
  description: "Update an incident's status (en_route, on_scene, resolved, escalated).",
  parameters: z.object({
    incidentId: z.string().describe("The incident ID"),
    status: z.enum(["en_route", "on_scene", "resolved", "escalated"]).describe("New status"),
    notes: z.string().describe("Status update notes").optional(),
    casualtyUpdate: z
      .object({
        confirmed: z.number().optional(),
        treated: z.number().optional(),
      })
      .describe("Updated casualty numbers")
      .optional(),
  }),
  async execute(args, ctx: { kv: KV; send: (event: string, data: unknown) => void }) {
    const state = await getState(ctx.kv);
    const inc = state.incidents[args.incidentId];
    if (!inc) return { error: `Incident ${args.incidentId} not found` };

    inc.status = args.status;
    inc.updatedAt = now();
    inc.timeline.push({
      time: now(),
      event: `Status → ${args.status}${args.notes ? `: ${args.notes}` : ""}`,
    });
    if (args.notes) inc.notes.push(args.notes);

    if (args.casualtyUpdate) {
      applyCasualtyUpdate(inc, args.casualtyUpdate);
    }

    // Release resources on resolution
    if (args.status === "resolved") {
      await releaseResourcesOnResolution(ctx.kv, state, inc, args.incidentId);
    }

    // Update resource statuses for en_route/on_scene
    if (args.status === "en_route" || args.status === "on_scene") {
      updateResourceStatuses(state, inc, args.status);
    }

    recalculateAlertLevel(state);
    await saveState(ctx.kv, state);

    const result = {
      incidentId: args.incidentId,
      newStatus: args.status,
      timeline: inc.timeline.slice(-5).map((t) => t.event),
      casualties: inc.casualties,
      incident: inc,
      systemAlertLevel: state.alertLevel,
    };
    ctx.send("incidents", result);
    return result;
  },
});
