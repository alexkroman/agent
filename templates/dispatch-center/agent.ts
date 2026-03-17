import { defineAgent } from "@alexkroman1/aai";
import { z } from "zod";
import type { HookContext, ToolContext } from "@alexkroman1/aai";

// ─── Types ───────────────────────────────────────────────────────────────────

type Severity = "critical" | "urgent" | "moderate" | "minor";
type IncidentType =
  | "medical"
  | "fire"
  | "hazmat"
  | "traffic"
  | "crime"
  | "natural_disaster"
  | "utility"
  | "other";
type Status =
  | "incoming"
  | "triaged"
  | "dispatched"
  | "en_route"
  | "on_scene"
  | "resolved"
  | "escalated";

interface Resource {
  id: string;
  type:
    | "ambulance"
    | "fire_engine"
    | "police"
    | "hazmat_team"
    | "helicopter"
    | "k9_unit"
    | "swat"
    | "ems_supervisor";
  callsign: string;
  status: "available" | "dispatched" | "en_route" | "on_scene" | "returning";
  assignedIncident: string | null;
  eta: number | null; // minutes
  capabilities: string[];
}

interface Incident {
  id: string;
  type: IncidentType;
  severity: Severity;
  status: Status;
  location: string;
  description: string;
  callerName: string;
  callerPhone: string;
  triageScore: number;
  assignedResources: string[];
  timeline: { time: number; event: string }[];
  notes: string[];
  createdAt: number;
  updatedAt: number;
  escalationLevel: number;
  protocolsActivated: string[];
  casualties: { confirmed: number; estimated: number; treated: number };
  hazards: string[];
}

interface DispatchState {
  incidents: Record<string, Incident>;
  resources: Resource[];
  incidentCounter: number;
  alertLevel: "green" | "yellow" | "orange" | "red"; // system-wide
  mutualAidRequested: boolean;
}

// ─── Session state ───────────────────────────────────────────────────────────

function createState(): DispatchState {
  return {
    incidents: {},
    resources: generateResources(),
    incidentCounter: 0,
    alertLevel: "green",
    mutualAidRequested: false,
  };
}

function generateResources(): Resource[] {
  return [
    {
      id: "R1",
      type: "ambulance",
      callsign: "Medic-1",
      status: "available",
      assignedIncident: null,
      eta: null,
      capabilities: ["als", "cardiac", "pediatric"],
    },
    {
      id: "R2",
      type: "ambulance",
      callsign: "Medic-2",
      status: "available",
      assignedIncident: null,
      eta: null,
      capabilities: ["als", "trauma"],
    },
    {
      id: "R3",
      type: "ambulance",
      callsign: "Medic-3",
      status: "available",
      assignedIncident: null,
      eta: null,
      capabilities: ["bls"],
    },
    {
      id: "R4",
      type: "fire_engine",
      callsign: "Engine-7",
      status: "available",
      assignedIncident: null,
      eta: null,
      capabilities: ["structural", "rescue", "ems_first_response"],
    },
    {
      id: "R5",
      type: "fire_engine",
      callsign: "Ladder-2",
      status: "available",
      assignedIncident: null,
      eta: null,
      capabilities: ["aerial", "rescue", "ventilation"],
    },
    {
      id: "R6",
      type: "police",
      callsign: "Unit-12",
      status: "available",
      assignedIncident: null,
      eta: null,
      capabilities: ["patrol", "traffic_control"],
    },
    {
      id: "R7",
      type: "police",
      callsign: "Unit-15",
      status: "available",
      assignedIncident: null,
      eta: null,
      capabilities: ["patrol", "investigation"],
    },
    {
      id: "R8",
      type: "hazmat_team",
      callsign: "HazMat-1",
      status: "available",
      assignedIncident: null,
      eta: null,
      capabilities: ["chemical", "biological", "radiological", "decon"],
    },
    {
      id: "R9",
      type: "helicopter",
      callsign: "LifeFlight-1",
      status: "available",
      assignedIncident: null,
      eta: null,
      capabilities: ["medevac", "search_rescue", "thermal_imaging"],
    },
    {
      id: "R10",
      type: "ems_supervisor",
      callsign: "EMS-Sup-1",
      status: "available",
      assignedIncident: null,
      eta: null,
      capabilities: ["mass_casualty", "triage_lead", "command"],
    },
    {
      id: "R11",
      type: "k9_unit",
      callsign: "K9-3",
      status: "available",
      assignedIncident: null,
      eta: null,
      capabilities: ["tracking", "narcotics", "explosives"],
    },
    {
      id: "R12",
      type: "swat",
      callsign: "TAC-1",
      status: "available",
      assignedIncident: null,
      eta: null,
      capabilities: ["tactical", "hostage_rescue", "high_risk_warrant"],
    },
  ];
}

// ─── Triage & scoring ────────────────────────────────────────────────────────

const SEVERITY_WEIGHTS: Record<Severity, number> = {
  critical: 100,
  urgent: 70,
  moderate: 40,
  minor: 10,
};

const TYPE_MULTIPLIERS: Record<IncidentType, number> = {
  medical: 1.2,
  fire: 1.3,
  hazmat: 1.5,
  traffic: 1.0,
  crime: 1.1,
  "natural_disaster": 1.8,
  utility: 0.8,
  other: 0.7,
};

function calculateTriageScore(
  severity: Severity,
  type: IncidentType,
  casualties: number,
  hazards: number,
): number {
  let score = SEVERITY_WEIGHTS[severity] * TYPE_MULTIPLIERS[type];
  score += Math.min(casualties * 15, 60); // up to 60 pts for casualties
  score += Math.min(hazards * 10, 30); // up to 30 pts for hazards
  return Math.round(Math.min(score, 250));
}

function recommendSeverity(description: string): Severity {
  const d = description.toLowerCase();
  const criticalKeywords = [
    "unconscious",
    "not breathing",
    "cardiac arrest",
    "trapped",
    "collapse",
    "explosion",
    "active shooter",
    "mass casualty",
  ];
  const urgentKeywords = [
    "bleeding",
    "chest pain",
    "difficulty breathing",
    "fire",
    "hazmat",
    "shooting",
    "stabbing",
    "multi-vehicle",
  ];
  const moderateKeywords = [
    "fall",
    "broken",
    "fracture",
    "smoke",
    "minor fire",
    "assault",
    "theft",
  ];

  if (criticalKeywords.some((k) => d.includes(k))) return "critical";
  if (urgentKeywords.some((k) => d.includes(k))) return "urgent";
  if (moderateKeywords.some((k) => d.includes(k))) return "moderate";
  return "minor";
}

function recommendType(description: string): IncidentType {
  const d = description.toLowerCase();
  const typeKeywords: Record<IncidentType, string[]> = {
    medical: [
      "chest pain",
      "breathing",
      "unconscious",
      "seizure",
      "allergic",
      "overdose",
      "cardiac",
      "stroke",
      "diabetic",
      "bleeding",
      "fall",
      "injury",
    ],
    fire: ["fire", "smoke", "flames", "burning", "arson"],
    hazmat: [
      "chemical",
      "spill",
      "gas leak",
      "fumes",
      "radiation",
      "contamination",
      "hazmat",
    ],
    traffic: [
      "accident",
      "crash",
      "collision",
      "vehicle",
      "rollover",
      "pedestrian struck",
      "hit and run",
    ],
    crime: [
      "robbery",
      "assault",
      "shooting",
      "stabbing",
      "burglar",
      "theft",
      "domestic",
      "hostage",
      "active shooter",
    ],
    "natural_disaster": [
      "earthquake",
      "flood",
      "tornado",
      "hurricane",
      "landslide",
      "wildfire",
      "tsunami",
    ],
    utility: [
      "power outage",
      "downed line",
      "water main",
      "gas main",
      "transformer",
    ],
    other: [],
  };

  let best: IncidentType = "other";
  let bestCount = 0;
  for (const [type, keywords] of Object.entries(typeKeywords)) {
    const count = keywords.filter((k) => d.includes(k)).length;
    if (count > bestCount) {
      bestCount = count;
      best = type as IncidentType;
    }
  }
  return best;
}

// ─── Protocol engine ─────────────────────────────────────────────────────────

interface Protocol {
  name: string;
  triggers: { types: IncidentType[]; minSeverity: Severity };
  steps: string[];
  requiredResources: Resource["type"][];
}

const PROTOCOLS: Protocol[] = [
  {
    name: "Mass Casualty Incident (MCI)",
    triggers: {
      types: ["medical", "fire", "natural_disaster", "traffic"],
      minSeverity: "critical",
    },
    steps: [
      "Establish Incident Command",
      "Request mutual aid if more than 10 casualties estimated",
      "Set up triage area using START protocol: Immediate (red), Delayed (yellow), Minor (green), Deceased (black)",
      "Assign triage lead (EMS supervisor)",
      "Establish patient collection point and treatment area",
      "Coordinate helicopter landing zone if needed",
      "Notify receiving hospitals and activate surge protocols",
    ],
    requiredResources: ["ambulance", "ems_supervisor", "fire_engine"],
  },
  {
    name: "Structure Fire - Working Fire",
    triggers: { types: ["fire"], minSeverity: "urgent" },
    steps: [
      "Dispatch minimum 2 engines and 1 ladder",
      "Establish incident command and 360-degree size-up",
      "Confirm water supply — nearest hydrant",
      "Search and rescue primary sweep",
      "Ventilation operations",
      "Establish RIT (Rapid Intervention Team)",
      "Request additional alarms if fire is not contained in 10 minutes",
    ],
    requiredResources: ["fire_engine"],
  },
  {
    name: "Hazardous Materials Response",
    triggers: { types: ["hazmat"], minSeverity: "moderate" },
    steps: [
      "Identify the substance using placard numbers or SDS if available",
      "Establish hot, warm, and cold zones",
      "Evacuate downwind at minimum 1000 feet for unknown substances",
      "Deploy HazMat team in appropriate PPE level",
      "Set up decontamination corridor",
      "Monitor air quality and wind direction continuously",
      "Coordinate with poison control and environmental agency",
    ],
    requiredResources: ["hazmat_team", "fire_engine", "ambulance"],
  },
  {
    name: "Active Threat / Active Shooter",
    triggers: { types: ["crime"], minSeverity: "critical" },
    steps: [
      "Dispatch SWAT and multiple patrol units",
      "Establish inner and outer perimeters",
      "Activate Rescue Task Force protocol — police escort for EMS into warm zone",
      "Stage ambulances at casualty collection point outside hot zone",
      "Request LifeFlight on standby",
      "Coordinate with school/building security for floor plans",
      "Establish family reunification point",
    ],
    requiredResources: ["swat", "police", "ambulance", "ems_supervisor"],
  },
  {
    name: "Multi-Vehicle Accident",
    triggers: { types: ["traffic"], minSeverity: "urgent" },
    steps: [
      "Dispatch engine company for extrication capability",
      "Request traffic control units to shut down lanes",
      "Triage patients using START protocol",
      "Check for fuel or hazmat spills",
      "Establish landing zone if helicopter transport needed",
      "Coordinate with DOT for road closures and detours",
    ],
    requiredResources: ["fire_engine", "ambulance", "police"],
  },
  {
    name: "Cardiac Arrest Protocol",
    triggers: { types: ["medical"], minSeverity: "critical" },
    steps: [
      "Instruct caller to begin CPR immediately — 30 compressions, 2 breaths",
      "Dispatch closest ALS unit and fire engine for first response",
      "Guide caller through AED use if available",
      "Time from call to first defibrillation is critical — target under 8 minutes",
      "Prepare for advanced airway management on arrival",
    ],
    requiredResources: ["ambulance", "fire_engine"],
  },
];

function getApplicableProtocols(
  type: IncidentType,
  severity: Severity,
): Protocol[] {
  const severityRank: Record<Severity, number> = {
    critical: 4,
    urgent: 3,
    moderate: 2,
    minor: 1,
  };
  return PROTOCOLS.filter((p) =>
    p.triggers.types.includes(type) &&
    severityRank[severity] >= severityRank[p.triggers.minSeverity]
  );
}

// ─── Resource recommendation engine ──────────────────────────────────────────

function recommendResources(
  type: IncidentType,
  severity: Severity,
  state: DispatchState,
): Resource[] {
  const needed: Resource["type"][] = [];

  // Base resource needs by incident type
  const baseNeeds: Record<IncidentType, Resource["type"][]> = {
    medical: ["ambulance"],
    fire: ["fire_engine", "ambulance"],
    hazmat: ["hazmat_team", "fire_engine", "ambulance"],
    traffic: ["police", "ambulance", "fire_engine"],
    crime: ["police"],
    "natural_disaster": ["fire_engine", "ambulance", "police"],
    utility: ["fire_engine"],
    other: [],
  };

  needed.push(...(baseNeeds[type] || []));

  // Severity escalation
  if (severity === "critical") {
    if (!needed.includes("ambulance")) needed.push("ambulance");
    needed.push("ems_supervisor");
    if (type === "crime") needed.push("swat");
  }
  if (severity === "urgent" && type === "fire") {
    needed.push("fire_engine"); // second engine
  }

  // Find available resources matching needs
  const recommended: Resource[] = [];
  const usedIds = new Set<string>();

  for (const needType of needed) {
    const available = state.resources.find(
      (r) =>
        r.type === needType && r.status === "available" && !usedIds.has(r.id),
    );
    if (available) {
      recommended.push(available);
      usedIds.add(available.id);
    }
  }

  return recommended;
}

// ─── System alert level calculation ──────────────────────────────────────────

function recalculateAlertLevel(state: DispatchState): void {
  const activeIncidents = Object.values(state.incidents).filter((i) =>
    !["resolved"].includes(i.status)
  );
  const criticalCount =
    activeIncidents.filter((i) => i.severity === "critical").length;
  const totalActive = activeIncidents.length;
  const availableResources =
    state.resources.filter((r) => r.status === "available").length;
  const totalResources = state.resources.length;
  const resourceUtilization = 1 - (availableResources / totalResources);

  if (criticalCount >= 3 || resourceUtilization > 0.85 || totalActive >= 8) {
    state.alertLevel = "red";
  } else if (
    criticalCount >= 2 || resourceUtilization > 0.65 || totalActive >= 5
  ) {
    state.alertLevel = "orange";
  } else if (
    criticalCount >= 1 || resourceUtilization > 0.4 || totalActive >= 3
  ) {
    state.alertLevel = "yellow";
  } else {
    state.alertLevel = "green";
  }

  // Auto-request mutual aid at red
  if (state.alertLevel === "red" && !state.mutualAidRequested) {
    state.mutualAidRequested = true;
  }
}

function now(): number {
  return Date.now();
}

// ─── KV persistence ─────────────────────────────────────────────────────────

const STATE_KEY = "dispatch:state";

async function saveState(
  ctx: { kv: ToolContext["kv"]; state: unknown },
): Promise<void> {
  await ctx.kv.set(STATE_KEY, ctx.state);
}

async function loadState(ctx: HookContext<DispatchState>): Promise<void> {
  const saved = await ctx.kv.get<DispatchState>(STATE_KEY);
  if (saved) {
    Object.assign(ctx.state, saved);
  }
}

// ─── Agent definition ────────────────────────────────────────────────────────

export default defineAgent({
  name: "Dispatch Command Center",
  transport: ["websocket"],

  greeting:
    "Dispatch Command Center online. Restoring operational state. I'm ready to take incoming calls, manage active incidents, or run dispatch operations. Say 'dashboard' for a full status report. What do we have.",

  instructions:
    `You are the AI-powered Emergency Dispatch Command Center. You coordinate emergency response for a metropolitan area. You manage incidents from initial 911 call through resolution.

Your role combines call-taker, dispatcher, and incident commander. You speak like an experienced dispatcher: calm, precise, and authoritative. Never panic. Use brevity codes and dispatch terminology naturally.

Your tools:

INCIDENT MANAGEMENT:
- incident_create: Log a new incident. Ask for location first, then nature of emergency, then caller info. Speed matters for critical calls.
- incident_triage: After creating, assess severity. The system recommends severity, type, and protocols. Review and confirm or override.
- incident_update_status: Move incidents through the workflow (en_route, on_scene, resolved, escalated).
- incident_get: Get details on a specific incident.
- incident_escalate: Escalate when an incident exceeds current capacity or severity increases.
- incident_add_note: Add ongoing situational updates.

RESOURCE MANAGEMENT:
- resources_dispatch: Assign units. The system recommends optimal resources based on incident type and severity. You can also manually dispatch specific units.
- resources_get_available: See what units are free.
- resources_update_status: Update unit status when units radio in.

OPERATIONS:
- ops_dashboard: Get the full operational picture.
- ops_protocols: Retrieve step-by-step response protocols. Follow them precisely for critical incidents.
- ops_run_scenario: Run training exercises.

SEARCH: Use web_search to look up hazmat placard numbers, drug interactions, building addresses, or other reference information during active incidents.

CALCULATIONS: Use run_code for ETA calculations, resource optimization, or casualty estimates.

Operational rules:
- Location is always the first priority in any emergency call
- Critical incidents get immediate dispatch, triage can happen simultaneously
- Never leave a critical incident without at least one resource dispatched
- Monitor resource utilization. If it exceeds 65 percent, warn about degraded capacity
- At red alert level, recommend mutual aid from neighboring jurisdictions
- Track time on all incidents. Escalate if critical incidents have no on-scene resources within 8 minutes
- When reporting the dashboard, lead with the most severe active incidents
- Use plain language for medical instructions to callers, dispatch terminology for unit communications

Radio style: "Medic-1, respond priority one to 400 Oak Street, report of cardiac arrest, CPR in progress." Keep it tight and professional.`,

  builtinTools: [],

  state: createState,

  onConnect: async (ctx) => {
    await loadState(ctx);
  },

  tools: {
    incident_create: {
      description: "Create a new incident from an incoming emergency call.",
      parameters: z.object({
        location: z.string().describe("Address or location description"),
        description: z.string().describe(
          "Nature of the emergency as described by caller",
        ),
        callerName: z.string().describe("Caller's name").optional(),
        callerPhone: z.string().describe("Callback number").optional(),
        estimatedCasualties: z.number().describe(
          "Estimated number of casualties if known",
        ).optional(),
        hazards: z.array(z.string()).describe(
          "Known hazards: fire, chemical, electrical, structural, weapons",
        ).optional(),
      }),
      execute: async (
        {
          location,
          description,
          callerName,
          callerPhone,
          estimatedCasualties,
          hazards,
        },
        ctx,
      ) => {
        const state = ctx.state;
        state.incidentCounter++;
        const id = `INC-${String(state.incidentCounter).padStart(4, "0")}`;

        const recSeverity = recommendSeverity(description);
        const recType = recommendType(description);
        const triageScore = calculateTriageScore(
          recSeverity,
          recType,
          estimatedCasualties || 0,
          hazards?.length || 0,
        );

        const incident: Incident = {
          id,
          type: recType,
          severity: recSeverity,
          status: "incoming",
          location,
          description,
          callerName: callerName || "Unknown",
          callerPhone: callerPhone || "Unknown",
          triageScore,
          assignedResources: [],
          timeline: [{
            time: now(),
            event: `Incident created: ${description}`,
          }],
          notes: [],
          createdAt: now(),
          updatedAt: now(),
          escalationLevel: 0,
          protocolsActivated: [],
          casualties: {
            confirmed: 0,
            estimated: estimatedCasualties || 0,
            treated: 0,
          },
          hazards: hazards || [],
        };

        state.incidents[id] = incident;
        recalculateAlertLevel(state);
        await saveState(ctx);

        const protocols = getApplicableProtocols(recType, recSeverity);
        const recommended = recommendResources(
          recType,
          recSeverity,
          state,
        );

        return {
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
          systemAlertLevel: state.alertLevel,
          message: recSeverity === "critical"
            ? `PRIORITY ONE — ${id} created. Immediate dispatch recommended. ${protocols.length} protocol(s) applicable.`
            : `${id} created. Triage score ${triageScore}. ${recommended.length} resource(s) recommended.`,
        };
      },
    },

    incident_triage: {
      description:
        "Triage an incident — confirm or override severity, type, hazards, and casualty count.",
      parameters: z.object({
        incidentId: z.string().describe("The incident ID"),
        severity: z.enum(["critical", "urgent", "moderate", "minor"])
          .describe("Confirmed severity after triage").optional(),
        type: z.enum([
          "medical",
          "fire",
          "hazmat",
          "traffic",
          "crime",
          "natural_disaster",
          "utility",
          "other",
        ]).describe("Confirmed incident type").optional(),
        additionalHazards: z.array(z.string()).describe(
          "Any additional hazards identified",
        ).optional(),
        casualtyUpdate: z.number().describe("Updated casualty count")
          .optional(),
        notes: z.string().describe("Triage notes").optional(),
      }),
      execute: async (
        {
          incidentId,
          severity,
          type,
          additionalHazards,
          casualtyUpdate,
          notes,
        },
        ctx,
      ) => {
        const state = ctx.state;
        const inc = state.incidents[incidentId];
        if (!inc) return { error: `Incident ${incidentId} not found` };

        if (severity) inc.severity = severity;
        if (type) inc.type = type;
        if (additionalHazards) inc.hazards.push(...additionalHazards);
        if (casualtyUpdate !== undefined) {
          inc.casualties.estimated = casualtyUpdate;
        }
        if (notes) inc.notes.push(notes);

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
          event:
            `Triaged: ${inc.severity} ${inc.type}, score ${inc.triageScore}`,
        });

        recalculateAlertLevel(state);
        await saveState(ctx);

        const protocols = getApplicableProtocols(inc.type, inc.severity);
        const recommended = recommendResources(
          inc.type,
          inc.severity,
          state,
        );

        return {
          incidentId,
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
          recommendedResources: recommended.map((r) => ({
            callsign: r.callsign,
            type: r.type,
          })),
          systemAlertLevel: state.alertLevel,
        };
      },
    },

    incident_update_status: {
      description:
        "Update an incident's status (en_route, on_scene, resolved, escalated).",
      parameters: z.object({
        incidentId: z.string().describe("The incident ID"),
        status: z.enum(["en_route", "on_scene", "resolved", "escalated"])
          .describe("New status"),
        notes: z.string().describe("Status update notes").optional(),
        casualtyUpdate: z.object({
          confirmed: z.number().optional(),
          treated: z.number().optional(),
        }).describe("Updated casualty numbers").optional(),
      }),
      execute: async (
        { incidentId, status, notes, casualtyUpdate },
        ctx,
      ) => {
        const state = ctx.state;
        const inc = state.incidents[incidentId];
        if (!inc) return { error: `Incident ${incidentId} not found` };

        inc.status = status;
        inc.updatedAt = now();
        inc.timeline.push({
          time: now(),
          event: `Status → ${status}${notes ? `: ${notes}` : ""}`,
        });
        if (notes) inc.notes.push(notes);

        if (casualtyUpdate) {
          if (casualtyUpdate.confirmed !== undefined) {
            inc.casualties.confirmed = casualtyUpdate.confirmed;
          }
          if (casualtyUpdate.treated !== undefined) {
            inc.casualties.treated = casualtyUpdate.treated;
          }
        }

        // Release resources on resolution
        if (status === "resolved") {
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
        }

        // Update resource statuses for en_route/on_scene
        if (status === "en_route" || status === "on_scene") {
          for (const rId of inc.assignedResources) {
            const r = state.resources.find((r) => r.id === rId);
            if (r) r.status = status;
          }
        }

        recalculateAlertLevel(state);
        await saveState(ctx);

        return {
          incidentId,
          newStatus: status,
          timeline: inc.timeline.slice(-5).map((t) => t.event),
          casualties: inc.casualties,
          systemAlertLevel: state.alertLevel,
        };
      },
    },

    incident_escalate: {
      description:
        "Escalate an incident when it exceeds current capacity or severity increases.",
      parameters: z.object({
        incidentId: z.string().describe("The incident ID"),
        reason: z.string().describe("Reason for escalation"),
        requestMutualAid: z.boolean().describe(
          "Whether to request mutual aid from neighboring jurisdictions",
        ).optional(),
        newSeverity: z.enum(["critical", "urgent"]).describe(
          "Escalated severity level",
        ).optional(),
      }),
      execute: async (
        { incidentId, reason, requestMutualAid, newSeverity },
        ctx,
      ) => {
        const state = ctx.state;
        const inc = state.incidents[incidentId];
        if (!inc) return { error: `Incident ${incidentId} not found` };

        inc.escalationLevel++;
        if (newSeverity) inc.severity = newSeverity;
        inc.status = "escalated";
        inc.updatedAt = now();
        inc.timeline.push({
          time: now(),
          event: `ESCALATED (Level ${inc.escalationLevel}): ${reason}`,
        });
        inc.notes.push(`Escalation: ${reason}`);

        if (requestMutualAid) {
          state.mutualAidRequested = true;
          inc.timeline.push({
            time: now(),
            event: "Mutual aid requested from neighboring jurisdictions",
          });
          // Simulate mutual aid resources arriving
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

        inc.triageScore = calculateTriageScore(
          inc.severity,
          inc.type,
          inc.casualties.estimated,
          inc.hazards.length,
        );
        recalculateAlertLevel(state);
        await saveState(ctx);

        const additionalResources = recommendResources(
          inc.type,
          inc.severity,
          state,
        ).filter(
          (r) => !inc.assignedResources.includes(r.id),
        );

        return {
          incidentId,
          escalationLevel: inc.escalationLevel,
          newSeverity: inc.severity,
          newTriageScore: inc.triageScore,
          mutualAidRequested: requestMutualAid || false,
          additionalResourcesAvailable: additionalResources.map((r) => ({
            callsign: r.callsign,
            type: r.type,
          })),
          systemAlertLevel: state.alertLevel,
          message:
            `ESCALATION CONFIRMED — ${incidentId} now Level ${inc.escalationLevel}. ${additionalResources.length} additional resource(s) available for dispatch.`,
        };
      },
    },

    incident_get: {
      description:
        "Get full details on a specific incident including timeline and assigned resources.",
      parameters: z.object({
        incidentId: z.string().describe("The incident ID"),
      }),
      execute: ({ incidentId }, ctx) => {
        const state = ctx.state;
        const inc = state.incidents[incidentId];
        if (!inc) return { error: `Incident ${incidentId} not found` };

        const assignedResourceDetails = inc.assignedResources.map(
          (rId) => {
            const r = state.resources.find((r) => r.id === rId);
            return r
              ? {
                callsign: r.callsign,
                type: r.type,
                status: r.status,
                eta: r.eta,
              }
              : null;
          },
        ).filter(Boolean);

        const ageMinutes = Math.round((now() - inc.createdAt) / 60000);

        return {
          ...inc,
          ageMinutes,
          assignedResourceDetails,
          applicableProtocols: getApplicableProtocols(
            inc.type,
            inc.severity,
          )
            .map((p) => p.name),
        };
      },
    },

    incident_add_note: {
      description: "Add a situational update note to an incident.",
      parameters: z.object({
        incidentId: z.string().describe("The incident ID"),
        note: z.string().describe("The note to add"),
        source: z.string().describe(
          "Who reported this — unit callsign or caller",
        ).optional(),
      }),
      execute: async ({ incidentId, note, source }, ctx) => {
        const state = ctx.state;
        const inc = state.incidents[incidentId];
        if (!inc) return { error: `Incident ${incidentId} not found` };

        const entry = source ? `[${source}] ${note}` : note;
        inc.notes.push(entry);
        inc.timeline.push({ time: now(), event: entry });
        inc.updatedAt = now();
        await saveState(ctx);

        return {
          incidentId,
          noteAdded: entry,
          totalNotes: inc.notes.length,
        };
      },
    },

    resources_dispatch: {
      description:
        "Dispatch units to an incident. Can auto-dispatch recommended resources or manually specify callsigns.",
      parameters: z.object({
        incidentId: z.string().describe("The incident ID"),
        callsigns: z.array(z.string()).describe(
          "Resource callsigns to dispatch. Use 'auto' for system-recommended resources.",
        ).optional(),
        autoDispatch: z.boolean().describe(
          "If true, automatically dispatch recommended resources",
        ).optional(),
        priority: z.enum(["routine", "priority", "emergency"]).describe(
          "Dispatch priority — affects simulated ETA",
        ).optional(),
      }),
      execute: async (
        { incidentId, callsigns, autoDispatch, priority },
        ctx,
      ) => {
        const state = ctx.state;
        const inc = state.incidents[incidentId];
        if (!inc) return { error: `Incident ${incidentId} not found` };

        const dispatched: {
          callsign: string;
          type: string;
          eta: number;
        }[] = [];
        const failed: { callsign: string; reason: string }[] = [];

        let resourcesToDispatch: Resource[] = [];

        if (autoDispatch) {
          resourcesToDispatch = recommendResources(
            inc.type,
            inc.severity,
            state,
          );
        } else if (callsigns) {
          for (const cs of callsigns) {
            const r = state.resources.find((r) =>
              r.callsign.toLowerCase() === cs.toLowerCase()
            );
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

        const etaBase = priority === "emergency"
          ? 3
          : priority === "priority"
          ? 6
          : 10;

        for (const r of resourcesToDispatch) {
          const eta = etaBase + Math.floor(Math.random() * 5);
          r.status = "dispatched";
          r.assignedIncident = incidentId;
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
        await saveState(ctx);

        const availableCount = state.resources.filter((r) =>
          r.status === "available"
        ).length;

        return {
          incidentId,
          dispatched,
          failed: failed.length > 0 ? failed : undefined,
          totalAssignedToIncident: inc.assignedResources.length,
          remainingAvailableResources: availableCount,
          systemAlertLevel: state.alertLevel,
          capacityWarning: availableCount <= 3
            ? "WARNING: Resource capacity critically low. Consider mutual aid."
            : undefined,
        };
      },
    },

    resources_get_available: {
      description: "List available resources, optionally filtered by type.",
      parameters: z.object({
        type: z.enum([
          "ambulance",
          "fire_engine",
          "police",
          "hazmat_team",
          "helicopter",
          "k9_unit",
          "swat",
          "ems_supervisor",
          "all",
        ]).describe("Filter by resource type, or 'all'").optional(),
      }),
      execute: ({ type }, ctx) => {
        const state = ctx.state;
        let resources = state.resources;
        if (type && type !== "all") {
          resources = resources.filter((r) => r.type === type);
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
            available: resources.filter((r) => r.status === "available")
              .length,
            committed: resources.filter((r) => r.status !== "available")
              .length,
          },
        };
      },
    },

    resources_update_status: {
      description: "Update a resource unit's status when it radios in.",
      parameters: z.object({
        callsign: z.string().describe("The resource callsign"),
        status: z.enum([
          "available",
          "dispatched",
          "en_route",
          "on_scene",
          "returning",
        ]).describe("New status"),
        notes: z.string().describe("Status notes").optional(),
      }),
      execute: async ({ callsign, status, notes }, ctx) => {
        const state = ctx.state;
        const resource = state.resources.find((r) =>
          r.callsign.toLowerCase() === callsign.toLowerCase()
        );
        if (!resource) {
          return { error: `Resource ${callsign} not found` };
        }

        const previousStatus = resource.status;
        resource.status = status;

        if (status === "available") {
          resource.assignedIncident = null;
          resource.eta = null;
        }

        // Log to incident timeline if assigned
        if (resource.assignedIncident) {
          const inc = state.incidents[resource.assignedIncident];
          if (inc) {
            inc.timeline.push({
              time: now(),
              event: `${callsign}: ${previousStatus} → ${status}${
                notes ? ` (${notes})` : ""
              }`,
            });
            inc.updatedAt = now();
          }
        }

        recalculateAlertLevel(state);
        await saveState(ctx);

        return {
          callsign: resource.callsign,
          previousStatus,
          newStatus: status,
          assignedIncident: resource.assignedIncident,
          systemAlertLevel: state.alertLevel,
        };
      },
    },

    ops_dashboard: {
      description:
        "Get the full operational dashboard: alert level, resource utilization, active incidents, and available resources.",
      execute: (_args, ctx) => {
        const state = ctx.state;

        const activeIncidents = Object.values(state.incidents)
          .filter((i) => i.status !== "resolved")
          .sort((a, b) => b.triageScore - a.triageScore);

        const resolvedCount =
          Object.values(state.incidents).filter((i) => i.status === "resolved")
            .length;

        const resourceSummary = {
          total: state.resources.length,
          available:
            state.resources.filter((r) => r.status === "available").length,
          dispatched:
            state.resources.filter((r) => r.status === "dispatched").length,
          enRoute:
            state.resources.filter((r) => r.status === "en_route").length,
          onScene:
            state.resources.filter((r) => r.status === "on_scene").length,
          returning:
            state.resources.filter((r) => r.status === "returning").length,
        };

        const utilization = Math.round(
          (1 - resourceSummary.available / resourceSummary.total) * 100,
        );

        return {
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
            ageMinutes: Math.round((now() - i.createdAt) / 60000),
            casualties: i.casualties,
          })),
          availableResources: state.resources.filter((r) =>
            r.status === "available"
          ).map((r) => ({
            callsign: r.callsign,
            type: r.type,
            capabilities: r.capabilities,
          })),
        };
      },
    },

    ops_protocols: {
      description:
        "Look up step-by-step response protocols for a given incident type and severity.",
      parameters: z.object({
        incidentType: z.enum([
          "medical",
          "fire",
          "hazmat",
          "traffic",
          "crime",
          "natural_disaster",
          "utility",
          "other",
        ]).describe("Type of incident"),
        severity: z.enum(["critical", "urgent", "moderate", "minor"])
          .describe("Severity level"),
      }),
      execute: ({ incidentType, severity }) => {
        const protocols = getApplicableProtocols(
          incidentType,
          severity,
        );
        if (protocols.length === 0) {
          return {
            message:
              "No specific protocols for this combination. Use standard operating procedures.",
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
    },

    ops_run_scenario: {
      description:
        "Run a training scenario that creates simulated incidents for dispatch practice.",
      parameters: z.object({
        scenario: z.enum([
          "mass_casualty",
          "multi_alarm_fire",
          "active_shooter",
          "natural_disaster",
          "highway_pileup",
        ]).describe("Scenario type to simulate"),
      }),
      execute: async ({ scenario }, ctx) => {
        const state = ctx.state;
        const scenarios: Record<
          string,
          { incidents: Partial<Incident>[]; narrative: string }
        > = {
          "mass_casualty": {
            narrative:
              "Bus crash at Main and 5th. School bus vs delivery truck. Multiple pediatric patients. Fuel spill on roadway.",
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
                description:
                  "Diesel fuel spill from delivery truck spreading toward storm drain, approximately 50 gallons",
                type: "hazmat",
                severity: "urgent",
              },
            ],
          },
          "multi_alarm_fire": {
            narrative:
              "Working structure fire at 200 Industrial Parkway. 3-story warehouse, heavy smoke showing. Reports of workers possibly trapped on upper floors.",
            incidents: [
              {
                location: "200 Industrial Parkway",
                description:
                  "3-story warehouse fully involved, heavy fire showing from all floors, possible trapped occupants on 2nd and 3rd floor, exposure buildings within 50 feet",
                type: "fire",
                severity: "critical",
              },
              {
                location: "200 Industrial Parkway — medical",
                description:
                  "2 workers with smoke inhalation evacuated from ground floor, one with burns to hands and arms",
                type: "medical",
                severity: "urgent",
              },
            ],
          },
          "active_shooter": {
            narrative:
              "Reports of active shooter at Riverside Mall. Multiple shots fired, crowds fleeing. At least 3 victims reported down in food court area.",
            incidents: [
              {
                location: "Riverside Mall, 1500 River Road — food court",
                description:
                  "Active shooter in food court area, multiple shots fired, at least 3 victims down, shooter last seen moving toward west entrance",
                type: "crime",
                severity: "critical",
              },
              {
                location: "Riverside Mall parking lot",
                description:
                  "Crowd crush injuries as people fled the building, several people trampled near east exit",
                type: "medical",
                severity: "urgent",
              },
            ],
          },
          "natural_disaster": {
            narrative:
              "EF-3 tornado touched down in residential area. Path of destruction along Oak Street corridor. Multiple structures collapsed. Power lines down.",
            incidents: [
              {
                location: "Oak Street between 10th and 15th",
                description:
                  "Tornado damage, multiple homes collapsed, people trapped in rubble, gas lines ruptured",
                type: "natural_disaster",
                severity: "critical",
              },
              {
                location: "Oak Street Elementary School",
                description:
                  "School roof partially collapsed, staff sheltering students in interior rooms, requesting welfare check",
                type: "natural_disaster",
                severity: "critical",
              },
              {
                location: "Oak Street and 12th — utility",
                description:
                  "Multiple downed power lines sparking, gas main rupture, area needs immediate isolation",
                type: "utility",
                severity: "urgent",
              },
            ],
          },
          "highway_pileup": {
            narrative:
              "20-plus vehicle pileup on Interstate 95 southbound near mile marker 42. Fog conditions. Multiple entrapments. Tanker truck involved.",
            incidents: [
              {
                location: "I-95 southbound mile marker 42",
                description:
                  "Multi-vehicle pileup, 20-plus vehicles, multiple entrapments, tanker truck involved with unknown cargo, heavy fog limiting visibility",
                type: "traffic",
                severity: "critical",
              },
              {
                location: "I-95 southbound — hazmat",
                description:
                  "Tanker truck leaking unknown liquid, placards not yet visible due to fog, setting up exclusion zone",
                type: "hazmat",
                severity: "critical",
              },
            ],
          },
        };

        const s = scenarios[scenario];
        if (!s) return { error: "Unknown scenario" };

        const created: string[] = [];
        for (const inc of s.incidents) {
          state.incidentCounter++;
          const id = `INC-${String(state.incidentCounter).padStart(4, "0")}`;
          const fullInc: Incident = {
            id,
            type: inc.type || "other",
            severity: inc.severity || "moderate",
            status: "incoming",
            location: inc.location || "Unknown",
            description: inc.description || "",
            callerName: "Scenario",
            callerPhone: "N/A",
            triageScore: calculateTriageScore(
              (inc.severity || "moderate") as Severity,
              (inc.type || "other") as IncidentType,
              0,
              0,
            ),
            assignedResources: [],
            timeline: [{
              time: now(),
              event: `SCENARIO: ${inc.description}`,
            }],
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
        await saveState(ctx);

        return {
          scenario,
          narrative: s.narrative,
          incidentsCreated: created,
          systemAlertLevel: state.alertLevel,
          message:
            `SCENARIO ACTIVE: ${s.narrative}. ${created.length} incidents created. Awaiting dispatch orders.`,
        };
      },
    },
  },
});
