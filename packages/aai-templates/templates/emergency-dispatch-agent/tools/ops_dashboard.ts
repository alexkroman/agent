import { dispatchSlot, incidentAgeMinutes, resourceBrief, resourceUtilization } from "../shared.ts";

/** Which `resourceSummary` counter a status belongs to — the two spellings differ. */
const COUNT_KEY = {
  available: "available",
  dispatched: "dispatched",
  en_route: "enRoute",
  on_scene: "onScene",
  returning: "returning",
} as const;

export default dispatchSlot.tool({
  description:
    "Get the full operational dashboard: alert level, resource utilization, active incidents, and available resources.",
  execute(_args, state) {
    // The incidents, split in one pass rather than filtered twice over the same
    // record: every incident is either active or resolved.
    type Incident = (typeof state.incidents)[string];
    const activeIncidents: Incident[] = [];
    let resolvedCount = 0;
    for (const incident of Object.values(state.incidents)) {
      if (incident.status === "resolved") resolvedCount += 1;
      else activeIncidents.push(incident);
    }
    activeIncidents.sort((a, b) => b.triageScore - a.triageScore);

    // Likewise the resource breakdown: five `.filter().length` scans and a sixth
    // for the briefs, all over the one list, become one walk of it.
    const resourceSummary = {
      total: state.resources.length,
      available: 0,
      dispatched: 0,
      enRoute: 0,
      onScene: 0,
      returning: 0,
    };
    const availableResources: ReturnType<typeof resourceBrief>[] = [];
    for (const resource of state.resources) {
      resourceSummary[COUNT_KEY[resource.status]] += 1;
      if (resource.status === "available") availableResources.push(resourceBrief(resource));
    }

    // Still `resourceUtilization`, not a ratio derived from the counts above:
    // that function is deliberately the ONE definition of the word, shared with
    // the alert level, and a second one here is how the two come to disagree.
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
      availableResources,
    };
  },
});
