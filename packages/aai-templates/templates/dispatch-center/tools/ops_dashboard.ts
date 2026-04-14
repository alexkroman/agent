import { tool } from "@alexkroman1/aai";
import type { Incident, KV } from "../shared.ts";
import { getState, INCIDENT_INDEX_KEY, now } from "../shared.ts";

export const opsDashboard = tool({
  description:
    "Get the full operational dashboard: alert level, resource utilization, active incidents, and available resources.",
  async execute(_args, ctx: { kv: KV; send: (event: string, data: unknown) => void }) {
    const state = await getState(ctx.kv);

    // Query KV for persisted incident snapshots via index
    const incidentIndex = (await ctx.kv.get<string[]>(INCIDENT_INDEX_KEY)) ?? [];
    const persistedSnapshots = (
      await Promise.all(
        incidentIndex.map(async (id) => {
          const value = await ctx.kv.get<Incident>(`incident:${id}`);
          return value ? { key: `incident:${id}`, value } : null;
        }),
      )
    ).filter((s): s is { key: string; value: Incident } => s !== null);

    const activeIncidents = Object.values(state.incidents)
      .filter((i) => i.status !== "resolved")
      .sort((a, b) => b.triageScore - a.triageScore);

    const resolvedCount = Object.values(state.incidents).filter(
      (i) => i.status === "resolved",
    ).length;

    const resourceSummary = {
      total: state.resources.length,
      available: state.resources.filter((r) => r.status === "available").length,
      dispatched: state.resources.filter((r) => r.status === "dispatched").length,
      enRoute: state.resources.filter((r) => r.status === "en_route").length,
      onScene: state.resources.filter((r) => r.status === "on_scene").length,
      returning: state.resources.filter((r) => r.status === "returning").length,
    };

    const utilization = Math.round((1 - resourceSummary.available / resourceSummary.total) * 100);

    const result = {
      systemAlertLevel: state.alertLevel,
      mutualAidActive: state.mutualAidRequested,
      resourceUtilization: `${utilization}%`,
      resourceSummary,
      activeIncidentCount: activeIncidents.length,
      resolvedIncidentCount: resolvedCount,
      activeIncidents: activeIncidents.map((i) => ({
        id: i.id,
        type: i.type,
        severity: i.severity,
        status: i.status,
        location: i.location,
        triageScore: i.triageScore,
        assignedResourceCount: i.assignedResources.length,
        ageMinutes: Math.round((now() - i.createdAt) / 60_000),
        casualties: i.casualties,
      })),
      availableResources: state.resources
        .filter((r) => r.status === "available")
        .map((r) => ({
          callsign: r.callsign,
          type: r.type,
          capabilities: r.capabilities,
        })),
      persistedIncidentCount: incidentIndex.length,
      persistedSnapshots: persistedSnapshots.map((s) => ({
        id: s.value.id,
        severity: s.value.severity,
        status: s.value.status,
      })),
      state,
    };
    ctx.send("incidents", result);
    return result;
  },
});
