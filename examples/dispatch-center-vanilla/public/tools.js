// Tool definitions — a plain-JavaScript port of the dispatch-center template's
// `tools/*.ts`. Each tool is `{ schema, execute }`:
//
//   - `schema`   is the exact JSON Schema the Voice Agent API expects in
//                `session.tools` (the template generated this from zod; here we
//                write it by hand — no zod dependency).
//   - `execute`  runs in the browser when a `tool.call` arrives and returns the
//                object that becomes the JSON-encoded `tool.result`.
//
// `ctx` carries `{ kv, send }`, matching the original `ToolContext`. `send`
// pushes a UI event ("incidents") that the dashboard listens to.

import {
  INCIDENT_INDEX_KEY,
  calculateTriageScore,
  deleteIncidentSnapshot,
  getApplicableProtocols,
  getState,
  now,
  recalculateAlertLevel,
  recommendResources,
  recommendSeverity,
  recommendType,
  saveIncidentSnapshot,
  saveState,
} from "./dispatch.js";

const SEVERITY_ENUM = ["critical", "urgent", "moderate", "minor"];
const TYPE_ENUM = [
  "medical",
  "fire",
  "hazmat",
  "traffic",
  "crime",
  "natural_disaster",
  "utility",
  "other",
];

/** Helper for the common `{ type: "object", properties, required }` shape. */
function fn(name, description, properties = {}, required = []) {
  return {
    type: "function",
    name,
    description,
    parameters: { type: "object", properties, required, additionalProperties: false },
  };
}

// ─── incident_create ─────────────────────────────────────────────────────────

const incidentCreate = {
  schema: fn(
    "incident_create",
    "Create a new incident from an incoming emergency call.",
    {
      location: { type: "string", description: "Address or location description" },
      description: { type: "string", description: "Nature of the emergency as described by caller" },
      callerName: { type: "string", description: "Caller's name" },
      callerPhone: { type: "string", description: "Callback number" },
      estimatedCasualties: { type: "number", description: "Estimated number of casualties if known" },
      hazards: {
        type: "array",
        items: { type: "string" },
        description: "Known hazards: fire, chemical, electrical, structural, weapons",
      },
    },
    ["location", "description"],
  ),
  async execute(args, ctx) {
    const state = await getState(ctx.kv);
    state.incidentCounter++;
    const id = `INC-${String(state.incidentCounter).padStart(4, "0")}`;

    const recSeverity = recommendSeverity(args.description);
    const recType = recommendType(args.description);
    const triageScore = calculateTriageScore(
      recSeverity,
      recType,
      args.estimatedCasualties ?? 0,
      args.hazards?.length ?? 0,
    );

    const incident = {
      id,
      type: recType,
      severity: recSeverity,
      status: "incoming",
      location: args.location,
      description: args.description,
      callerName: args.callerName ?? "Unknown",
      callerPhone: args.callerPhone ?? "Unknown",
      triageScore,
      assignedResources: [],
      timeline: [{ time: now(), event: `Incident created: ${args.description}` }],
      notes: [],
      createdAt: now(),
      updatedAt: now(),
      escalationLevel: 0,
      protocolsActivated: [],
      casualties: { confirmed: 0, estimated: args.estimatedCasualties ?? 0, treated: 0 },
      hazards: args.hazards ?? [],
    };

    state.incidents[id] = incident;
    recalculateAlertLevel(state);
    await saveState(ctx.kv, state);
    await saveIncidentSnapshot(ctx.kv, incident);

    const protocols = getApplicableProtocols(recType, recSeverity);
    const recommended = recommendResources(recType, recSeverity, state);

    const result = {
      incidentId: id,
      recommendedSeverity: recSeverity,
      recommendedType: recType,
      triageScore,
      applicableProtocols: protocols.map((p) => p.name),
      recommendedResources: recommended.map((r) => ({
        callsign: r.callsign,
        type: r.type,
        capabilities: r.capabilities,
      })),
      incident,
      systemAlertLevel: state.alertLevel,
      message:
        recSeverity === "critical"
          ? `PRIORITY ONE — ${id} created. Immediate dispatch recommended. ${protocols.length} protocol(s) applicable.`
          : `${id} created. Triage score ${triageScore}. ${recommended.length} resource(s) recommended.`,
    };
    ctx.send("incidents", result);
    return result;
  },
};

// ─── incident_triage ───────────────────────────────────────────────────────────

const incidentTriage = {
  schema: fn(
    "incident_triage",
    "Triage an incident — confirm or override severity, type, hazards, and casualty count.",
    {
      incidentId: { type: "string", description: "The incident ID" },
      severity: { type: "string", enum: SEVERITY_ENUM, description: "Confirmed severity after triage" },
      type: { type: "string", enum: TYPE_ENUM, description: "Confirmed incident type" },
      additionalHazards: {
        type: "array",
        items: { type: "string" },
        description: "Any additional hazards identified",
      },
      casualtyUpdate: { type: "number", description: "Updated casualty count" },
      notes: { type: "string", description: "Triage notes" },
    },
    ["incidentId"],
  ),
  async execute(args, ctx) {
    const state = await getState(ctx.kv);
    const inc = state.incidents[args.incidentId];
    if (!inc) return { error: `Incident ${args.incidentId} not found` };

    if (args.severity) inc.severity = args.severity;
    if (args.type) inc.type = args.type;
    if (args.additionalHazards) inc.hazards.push(...args.additionalHazards);
    if (args.casualtyUpdate !== undefined) inc.casualties.estimated = args.casualtyUpdate;
    if (args.notes) inc.notes.push(args.notes);

    inc.triageScore = calculateTriageScore(
      inc.severity,
      inc.type,
      inc.casualties.estimated,
      inc.hazards.length,
    );
    inc.status = "triaged";
    inc.updatedAt = now();
    inc.timeline.push({
      time: now(),
      event: `Triaged: ${inc.severity} ${inc.type}, score ${inc.triageScore}`,
    });

    recalculateAlertLevel(state);
    await saveState(ctx.kv, state);

    const protocols = getApplicableProtocols(inc.type, inc.severity);
    const recommended = recommendResources(inc.type, inc.severity, state);

    const result = {
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
      incident: inc,
      systemAlertLevel: state.alertLevel,
    };
    ctx.send("incidents", result);
    return result;
  },
};

// ─── incident_update_status ──────────────────────────────────────────────────────

const incidentUpdateStatus = {
  schema: fn(
    "incident_update_status",
    "Update an incident's status (en_route, on_scene, resolved, escalated).",
    {
      incidentId: { type: "string", description: "The incident ID" },
      status: {
        type: "string",
        enum: ["en_route", "on_scene", "resolved", "escalated"],
        description: "New status",
      },
      notes: { type: "string", description: "Status update notes" },
      casualtyUpdate: {
        type: "object",
        properties: { confirmed: { type: "number" }, treated: { type: "number" } },
        description: "Updated casualty numbers",
      },
    },
    ["incidentId", "status"],
  ),
  async execute(args, ctx) {
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
      if (args.casualtyUpdate.confirmed !== undefined) inc.casualties.confirmed = args.casualtyUpdate.confirmed;
      if (args.casualtyUpdate.treated !== undefined) inc.casualties.treated = args.casualtyUpdate.treated;
    }

    if (args.status === "resolved") {
      for (const rId of inc.assignedResources) {
        const r = state.resources.find((r) => r.id === rId);
        if (r) {
          r.status = "returning";
          r.assignedIncident = null;
          r.eta = null;
          setTimeout(() => {
            r.status = "available";
          }, 2000);
        }
      }
      inc.timeline.push({ time: now(), event: "All resources released — incident closed" });
      await deleteIncidentSnapshot(ctx.kv, args.incidentId);
    }

    if (args.status === "en_route" || args.status === "on_scene") {
      for (const rId of inc.assignedResources) {
        const r = state.resources.find((r) => r.id === rId);
        if (r) r.status = args.status;
      }
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
};

// ─── incident_get ──────────────────────────────────────────────────────────────

const incidentGet = {
  schema: fn(
    "incident_get",
    "Get full details on a specific incident including timeline and assigned resources.",
    { incidentId: { type: "string", description: "The incident ID" } },
    ["incidentId"],
  ),
  async execute(args, ctx) {
    const state = await getState(ctx.kv);
    const inc = state.incidents[args.incidentId];
    if (!inc) return { error: `Incident ${args.incidentId} not found` };

    const assignedResourceDetails = inc.assignedResources
      .map((rId) => {
        const r = state.resources.find((r) => r.id === rId);
        return r ? { callsign: r.callsign, type: r.type, status: r.status, eta: r.eta } : null;
      })
      .filter(Boolean);

    const ageMinutes = Math.round((now() - inc.createdAt) / 60_000);

    return {
      ...inc,
      ageMinutes,
      assignedResourceDetails,
      applicableProtocols: getApplicableProtocols(inc.type, inc.severity).map((p) => p.name),
    };
  },
};

// ─── incident_escalate ───────────────────────────────────────────────────────────

const incidentEscalate = {
  schema: fn(
    "incident_escalate",
    "Escalate an incident when it exceeds current capacity or severity increases.",
    {
      incidentId: { type: "string", description: "The incident ID" },
      reason: { type: "string", description: "Reason for escalation" },
      requestMutualAid: {
        type: "boolean",
        description: "Whether to request mutual aid from neighboring jurisdictions",
      },
      newSeverity: {
        type: "string",
        enum: ["critical", "urgent"],
        description: "Escalated severity level",
      },
    },
    ["incidentId", "reason"],
  ),
  async execute(args, ctx) {
    const state = await getState(ctx.kv);
    const inc = state.incidents[args.incidentId];
    if (!inc) return { error: `Incident ${args.incidentId} not found` };

    inc.escalationLevel++;
    if (args.newSeverity) inc.severity = args.newSeverity;
    inc.status = "escalated";
    inc.updatedAt = now();
    inc.timeline.push({ time: now(), event: `ESCALATED (Level ${inc.escalationLevel}): ${args.reason}` });
    inc.notes.push(`Escalation: ${args.reason}`);

    if (args.requestMutualAid) {
      state.mutualAidRequested = true;
      inc.timeline.push({ time: now(), event: "Mutual aid requested from neighboring jurisdictions" });
      state.resources.push(
        {
          id: `MA-${Date.now()}-1`,
          type: "ambulance",
          callsign: "Mutual-Aid-Medic",
          status: "available",
          assignedIncident: null,
          eta: null,
          capabilities: ["als"],
        },
        {
          id: `MA-${Date.now()}-2`,
          type: "fire_engine",
          callsign: "Mutual-Aid-Engine",
          status: "available",
          assignedIncident: null,
          eta: null,
          capabilities: ["structural"],
        },
      );
    }

    inc.triageScore = calculateTriageScore(inc.severity, inc.type, inc.casualties.estimated, inc.hazards.length);
    recalculateAlertLevel(state);
    await saveState(ctx.kv, state);

    const additionalResources = recommendResources(inc.type, inc.severity, state).filter(
      (r) => !inc.assignedResources.includes(r.id),
    );

    return {
      incidentId: args.incidentId,
      escalationLevel: inc.escalationLevel,
      newSeverity: inc.severity,
      newTriageScore: inc.triageScore,
      mutualAidRequested: args.requestMutualAid,
      additionalResourcesAvailable: additionalResources.map((r) => ({ callsign: r.callsign, type: r.type })),
      systemAlertLevel: state.alertLevel,
      message: `ESCALATION CONFIRMED — ${args.incidentId} now Level ${inc.escalationLevel}. ${additionalResources.length} additional resource(s) available for dispatch.`,
    };
  },
};

// ─── incident_add_note ───────────────────────────────────────────────────────────

const incidentAddNote = {
  schema: fn(
    "incident_add_note",
    "Add a situational update note to an incident.",
    {
      incidentId: { type: "string", description: "The incident ID" },
      note: { type: "string", description: "The note to add" },
      source: { type: "string", description: "Who reported this — unit callsign or caller" },
    },
    ["incidentId", "note"],
  ),
  async execute(args, ctx) {
    const state = await getState(ctx.kv);
    const inc = state.incidents[args.incidentId];
    if (!inc) return { error: `Incident ${args.incidentId} not found` };

    const entry = args.source ? `[${args.source}] ${args.note}` : args.note;
    inc.notes.push(entry);
    inc.timeline.push({ time: now(), event: entry });
    inc.updatedAt = now();
    await saveState(ctx.kv, state);

    return { incidentId: args.incidentId, noteAdded: entry, totalNotes: inc.notes.length };
  },
};

// ─── resources_dispatch ──────────────────────────────────────────────────────────

const resourcesDispatch = {
  schema: fn(
    "resources_dispatch",
    "Dispatch units to an incident. Can auto-dispatch recommended resources or manually specify callsigns.",
    {
      incidentId: { type: "string", description: "The incident ID" },
      callsigns: {
        type: "array",
        items: { type: "string" },
        description: "Resource callsigns to dispatch. Use 'auto' for system-recommended resources.",
      },
      autoDispatch: {
        type: "boolean",
        description: "If true, automatically dispatch recommended resources",
      },
      priority: {
        type: "string",
        enum: ["routine", "priority", "emergency"],
        description: "Dispatch priority — affects simulated ETA",
      },
    },
    ["incidentId"],
  ),
  async execute(args, ctx) {
    const state = await getState(ctx.kv);
    const inc = state.incidents[args.incidentId];
    if (!inc) return { error: `Incident ${args.incidentId} not found` };

    const dispatched = [];
    const failed = [];
    let resourcesToDispatch = [];

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
      inc.timeline.push({ time: now(), event: `Dispatched ${r.callsign} — ETA ${eta} min` });
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
        availableCount <= 3 ? "WARNING: Resource capacity critically low. Consider mutual aid." : undefined,
    };
  },
};

// ─── resources_get_available ─────────────────────────────────────────────────────

const resourcesGetAvailable = {
  schema: fn(
    "resources_get_available",
    "List available resources, optionally filtered by type.",
    {
      type: {
        type: "string",
        enum: [
          "ambulance",
          "fire_engine",
          "police",
          "hazmat_team",
          "helicopter",
          "k9_unit",
          "swat",
          "ems_supervisor",
          "all",
        ],
        description: "Filter by resource type, or 'all'",
      },
    },
    [],
  ),
  async execute(args, ctx) {
    const state = await getState(ctx.kv);
    let resources = state.resources;
    if (args.type && args.type !== "all") {
      resources = resources.filter((r) => r.type === args.type);
    }

    return {
      resources: resources.map((r) => ({
        callsign: r.callsign,
        type: r.type,
        status: r.status,
        assignedIncident: r.assignedIncident,
        eta: r.eta,
        capabilities: r.capabilities,
      })),
      summary: {
        total: resources.length,
        available: resources.filter((r) => r.status === "available").length,
        committed: resources.filter((r) => r.status !== "available").length,
      },
    };
  },
};

// ─── resources_update_status ─────────────────────────────────────────────────────

const resourcesUpdateStatus = {
  schema: fn(
    "resources_update_status",
    "Update a resource unit's status when it radios in.",
    {
      callsign: { type: "string", description: "The resource callsign" },
      status: {
        type: "string",
        enum: ["available", "dispatched", "en_route", "on_scene", "returning"],
        description: "New status",
      },
      notes: { type: "string", description: "Status notes" },
    },
    ["callsign", "status"],
  ),
  async execute(args, ctx) {
    const state = await getState(ctx.kv);
    const resource = state.resources.find((r) => r.callsign.toLowerCase() === args.callsign.toLowerCase());
    if (!resource) return { error: `Resource ${args.callsign} not found` };

    const previousStatus = resource.status;
    resource.status = args.status;

    if (args.status === "available") {
      resource.assignedIncident = null;
      resource.eta = null;
    }

    if (resource.assignedIncident) {
      const inc = state.incidents[resource.assignedIncident];
      if (inc) {
        inc.timeline.push({
          time: now(),
          event: `${args.callsign}: ${previousStatus} → ${args.status}${args.notes ? ` (${args.notes})` : ""}`,
        });
        inc.updatedAt = now();
      }
    }

    recalculateAlertLevel(state);
    await saveState(ctx.kv, state);

    return {
      callsign: resource.callsign,
      previousStatus,
      newStatus: args.status,
      assignedIncident: resource.assignedIncident,
      systemAlertLevel: state.alertLevel,
    };
  },
};

// ─── ops_dashboard ─────────────────────────────────────────────────────────────

const opsDashboard = {
  schema: fn(
    "ops_dashboard",
    "Get the full operational dashboard: alert level, resource utilization, active incidents, and available resources.",
    {},
    [],
  ),
  async execute(_args, ctx) {
    const state = await getState(ctx.kv);

    const incidentIndex = (await ctx.kv.get(INCIDENT_INDEX_KEY)) ?? [];
    const persistedSnapshots = (
      await Promise.all(
        incidentIndex.map(async (id) => {
          const value = await ctx.kv.get(`incident:${id}`);
          return value ? { key: `incident:${id}`, value } : null;
        }),
      )
    ).filter((s) => s !== null);

    const activeIncidents = Object.values(state.incidents)
      .filter((i) => i.status !== "resolved")
      .sort((a, b) => b.triageScore - a.triageScore);

    const resolvedCount = Object.values(state.incidents).filter((i) => i.status === "resolved").length;

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
        .map((r) => ({ callsign: r.callsign, type: r.type, capabilities: r.capabilities })),
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
};

// ─── ops_protocols ─────────────────────────────────────────────────────────────

const opsProtocols = {
  schema: fn(
    "ops_protocols",
    "Look up step-by-step response protocols for a given incident type and severity.",
    {
      incidentType: { type: "string", enum: TYPE_ENUM, description: "Type of incident" },
      severity: { type: "string", enum: SEVERITY_ENUM, description: "Severity level" },
    },
    ["incidentType", "severity"],
  ),
  async execute(args) {
    const protocols = getApplicableProtocols(args.incidentType, args.severity);
    if (protocols.length === 0) {
      return {
        message: "No specific protocols for this combination. Use standard operating procedures.",
        protocols: [],
      };
    }
    return {
      protocols: protocols.map((p) => ({
        name: p.name,
        steps: p.steps,
        requiredResources: p.requiredResources,
      })),
    };
  },
};

// ─── ops_run_scenario ──────────────────────────────────────────────────────────

const SCENARIOS = {
  mass_casualty: {
    narrative:
      "Bus crash at Main and 5th. School bus vs delivery truck. Multiple pediatric patients. Fuel spill.",
    incidents: [
      {
        location: "Main St and 5th Ave intersection",
        description:
          "School bus collision with delivery truck, multiple children injured, bus on its side, fuel leaking",
        type: "traffic",
        severity: "critical",
      },
      {
        location: "Main St and 5th Ave — fuel spill",
        description: "Diesel fuel spill from delivery truck spreading toward storm drain, ~50 gallons",
        type: "hazmat",
        severity: "urgent",
      },
    ],
  },
  multi_alarm_fire: {
    narrative:
      "Working structure fire at 200 Industrial Parkway. 3-story warehouse, heavy smoke. Workers possibly trapped.",
    incidents: [
      {
        location: "200 Industrial Parkway",
        description: "3-story warehouse fully involved, possible trapped occupants on 2nd/3rd floor",
        type: "fire",
        severity: "critical",
      },
      {
        location: "200 Industrial Parkway — medical",
        description: "2 workers with smoke inhalation, one with burns",
        type: "medical",
        severity: "urgent",
      },
    ],
  },
  active_shooter: {
    narrative:
      "Active shooter at Riverside Mall. Multiple shots fired, crowds fleeing. At least 3 victims down in food court.",
    incidents: [
      {
        location: "Riverside Mall, 1500 River Road — food court",
        description:
          "Active shooter, multiple shots, at least 3 victims down, shooter moving toward west entrance",
        type: "crime",
        severity: "critical",
      },
      {
        location: "Riverside Mall parking lot",
        description: "Crowd crush injuries, several trampled near east exit",
        type: "medical",
        severity: "urgent",
      },
    ],
  },
  natural_disaster: {
    narrative:
      "EF-3 tornado in residential area. Oak Street corridor. Multiple structures collapsed. Power lines down.",
    incidents: [
      {
        location: "Oak Street between 10th and 15th",
        description: "Tornado damage, homes collapsed, people trapped, gas lines ruptured",
        type: "natural_disaster",
        severity: "critical",
      },
      {
        location: "Oak Street Elementary School",
        description: "School roof partially collapsed, staff sheltering students",
        type: "natural_disaster",
        severity: "critical",
      },
      {
        location: "Oak Street and 12th — utility",
        description: "Downed power lines sparking, gas main rupture, area needs isolation",
        type: "utility",
        severity: "urgent",
      },
    ],
  },
  highway_pileup: {
    narrative:
      "20+ vehicle pileup on I-95 southbound mile marker 42. Fog. Multiple entrapments. Tanker truck involved.",
    incidents: [
      {
        location: "I-95 southbound mile marker 42",
        description:
          "Multi-vehicle pileup, 20+ vehicles, multiple entrapments, tanker with unknown cargo, heavy fog",
        type: "traffic",
        severity: "critical",
      },
      {
        location: "I-95 southbound — hazmat",
        description: "Tanker leaking unknown liquid, placards not visible, exclusion zone being set up",
        type: "hazmat",
        severity: "critical",
      },
    ],
  },
};

const opsRunScenario = {
  schema: fn(
    "ops_run_scenario",
    "Run a training scenario that creates simulated incidents for dispatch practice.",
    {
      scenario: {
        type: "string",
        enum: ["mass_casualty", "multi_alarm_fire", "active_shooter", "natural_disaster", "highway_pileup"],
        description: "Scenario type to simulate",
      },
    },
    ["scenario"],
  ),
  async execute(args, ctx) {
    const state = await getState(ctx.kv);
    const s = SCENARIOS[args.scenario];
    if (!s) return { error: "Unknown scenario" };

    const created = [];
    for (const scenarioInc of s.incidents) {
      state.incidentCounter++;
      const id = `INC-${String(state.incidentCounter).padStart(4, "0")}`;
      const fullInc = {
        id,
        type: scenarioInc.type || "other",
        severity: scenarioInc.severity || "moderate",
        status: "incoming",
        location: scenarioInc.location || "Unknown",
        description: scenarioInc.description || "",
        callerName: "Scenario",
        callerPhone: "N/A",
        triageScore: calculateTriageScore(
          scenarioInc.severity || "moderate",
          scenarioInc.type || "other",
          0,
          0,
        ),
        assignedResources: [],
        timeline: [{ time: now(), event: `SCENARIO: ${scenarioInc.description}` }],
        notes: [],
        createdAt: now(),
        updatedAt: now(),
        escalationLevel: 0,
        protocolsActivated: [],
        casualties: { confirmed: 0, estimated: 0, treated: 0 },
        hazards: [],
      };
      state.incidents[id] = fullInc;
      created.push(id);
    }

    recalculateAlertLevel(state);
    await saveState(ctx.kv, state);

    const result = {
      scenario: args.scenario,
      narrative: s.narrative,
      incidentsCreated: created,
      systemAlertLevel: state.alertLevel,
      message: `SCENARIO ACTIVE: ${s.narrative}. ${created.length} incidents created. Awaiting dispatch orders.`,
    };
    ctx.send("incidents", result);
    return result;
  },
};

// ─── Registry ─────────────────────────────────────────────────────────────────

/** All tools, keyed by name — mirrors the `tools:` map in the template's agent.ts. */
export const TOOLS = {
  incident_add_note: incidentAddNote,
  incident_create: incidentCreate,
  incident_escalate: incidentEscalate,
  incident_get: incidentGet,
  incident_triage: incidentTriage,
  incident_update_status: incidentUpdateStatus,
  ops_dashboard: opsDashboard,
  ops_protocols: opsProtocols,
  ops_run_scenario: opsRunScenario,
  resources_dispatch: resourcesDispatch,
  resources_get_available: resourcesGetAvailable,
  resources_update_status: resourcesUpdateStatus,
};

/** The JSON-Schema array sent in `session.update`'s `session.tools`. */
export const TOOL_SCHEMAS = Object.values(TOOLS).map((t) => t.schema);
