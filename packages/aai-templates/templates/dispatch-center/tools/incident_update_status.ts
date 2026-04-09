import type { KV, Status } from "../_shared.ts";
import {
  deleteIncidentSnapshot,
  getState,
  now,
  recalculateAlertLevel,
  saveState,
} from "../_shared.ts";

export const description = "Update an incident's status (en_route, on_scene, resolved, escalated).";

export const parameters = {
  type: "object",
  properties: {
    incidentId: { type: "string", description: "The incident ID" },
    status: {
      type: "string",
      enum: ["en_route", "on_scene", "resolved", "escalated"],
      description: "New status",
    },
    notes: { type: "string", description: "Status update notes" },
    casualtyUpdate: {
      type: "object",
      properties: {
        confirmed: { type: "number" },
        treated: { type: "number" },
      },
      description: "Updated casualty numbers",
    },
  },
  required: ["incidentId", "status"],
};

export default async function execute(
  args: {
    incidentId: string;
    status: Status;
    notes?: string;
    casualtyUpdate?: { confirmed?: number; treated?: number };
  },
  ctx: { kv: KV },
) {
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
    if (args.casualtyUpdate.confirmed !== undefined) {
      inc.casualties.confirmed = args.casualtyUpdate.confirmed;
    }
    if (args.casualtyUpdate.treated !== undefined) {
      inc.casualties.treated = args.casualtyUpdate.treated;
    }
  }

  // Release resources on resolution
  if (args.status === "resolved") {
    for (const rId of inc.assignedResources) {
      const r = state.resources.find((r) => r.id === rId);
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
    await deleteIncidentSnapshot(ctx.kv, args.incidentId);
  }

  // Update resource statuses for en_route/on_scene
  if (args.status === "en_route" || args.status === "on_scene") {
    for (const rId of inc.assignedResources) {
      const r = state.resources.find((r) => r.id === rId);
      if (r) r.status = args.status;
    }
  }

  recalculateAlertLevel(state);
  await saveState(ctx.kv, state);

  return {
    incidentId: args.incidentId,
    newStatus: args.status,
    timeline: inc.timeline.slice(-5).map((t) => t.event),
    casualties: inc.casualties,
    systemAlertLevel: state.alertLevel,
  };
}
