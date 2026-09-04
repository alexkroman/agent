import { dispatchSlot, incidentAgeMinutes, resourceBrief, resourceUtilization } from "../shared.ts";

export default dispatchSlot.tool({
  description:
    "Get the full operational dashboard: alert level, resource utilization, active incidents, and available resources.",
  execute(_args, state) {
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

    const utilization = Math.round(resourceUtilization(state) * 100);

    return {
      systemAlertLevel: state.alertLevel,
      // Derived, not stored: mutual aid is requested at red alert and stood
      // down when the level drops back below it, so the alert level IS the
      // fact and the two can never disagree.
      mutualAidActive: state.alertLevel === "red",
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
        ageMinutes: incidentAgeMinutes(i),
        casualties: i.casualties,
      })),
      availableResources: state.resources
        .filter((r) => r.status === "available")
        .map(resourceBrief),
    };
  },
});
