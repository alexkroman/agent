// ─── Types ───────────────────────────────────────────────────────────────────

import type { ToolContext } from "@alexkroman1/aai";
import { createKeyedLock, withLock } from "@alexkroman1/aai";

export const SEVERITIES = ["critical", "urgent", "moderate", "minor"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const INCIDENT_TYPES = [
  "medical",
  "fire",
  "hazmat",
  "traffic",
  "crime",
  "natural_disaster",
  "utility",
  "other",
] as const;
export type IncidentType = (typeof INCIDENT_TYPES)[number];

export type Status =
  | "incoming"
  | "triaged"
  | "dispatched"
  | "en_route"
  | "on_scene"
  | "resolved"
  | "escalated";

export const RESOURCE_TYPES = [
  "ambulance",
  "fire_engine",
  "police",
  "hazmat_team",
  "helicopter",
  "k9_unit",
  "swat",
  "ems_supervisor",
] as const;

export const RESOURCE_STATUSES = [
  "available",
  "dispatched",
  "en_route",
  "on_scene",
  "returning",
] as const;

export interface Resource {
  id: string;
  type: (typeof RESOURCE_TYPES)[number];
  callsign: string;
  status: (typeof RESOURCE_STATUSES)[number];
  assignedIncident: string | null;
  eta: number | null;
  capabilities: string[];
}

export interface Incident {
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
  createdAt: number;
  updatedAt: number;
  escalationLevel: number;
  protocolsActivated: string[];
  casualties: { confirmed: number; estimated: number; treated: number };
  hazards: string[];
}

export interface DispatchState {
  incidents: Record<string, Incident>;
  resources: Resource[];
  incidentCounter: number;
  mutualAidCounter: number;
  alertLevel: "green" | "yellow" | "orange" | "red";
  mutualAidRequested: boolean;
}

/**
 * Trimmed, non-PII incident view sent to the browser. Never include caller
 * name/phone here — this reaches the connected browser client, which only
 * renders these fields.
 *
 * This is precisely why `syncState` takes a projection rather than a flag:
 * `DispatchState` holds caller details, and the author decides what leaves
 * the server.
 */
export interface IncidentSummary {
  id: string;
  severity: Severity;
  status: Status;
  location: string;
}

export function incidentSummary(inc: Incident): IncidentSummary {
  return { id: inc.id, severity: inc.severity, status: inc.status, location: inc.location };
}

/** One incident as the browser sees it — see `dashboardView`. */
export interface DashboardView {
  systemAlertLevel: DispatchState["alertLevel"];
  incidents: IncidentSummary[];
}

/** The `syncState` projection — the whole contract with client.tsx. */
export function dashboardView(state: StateSlot): DashboardView {
  const dispatch = state.dispatch;
  return {
    systemAlertLevel: dispatch?.alertLevel ?? "green",
    incidents: Object.values(dispatch?.incidents ?? {}).map(incidentSummary),
  };
}

// ─── State helpers ───────────────────────────────────────────────────────────
// The dispatch board lives in `ctx.state`, the agent's per-session mutable
// state — sessions must not see each other's incidents, and ctx.state gives
// that isolation by construction. Nothing here needs to outlive the session.

export type StateSlot = { dispatch?: DispatchState };

// ─── Resource generation ────────────────────────────────────────────────────

const RESOURCE_DEFS: [string, Resource["type"], string, string[]][] = [
  ["R1", "ambulance", "Medic-1", ["als", "cardiac", "pediatric"]],
  ["R2", "ambulance", "Medic-2", ["als", "trauma"]],
  ["R3", "ambulance", "Medic-3", ["bls"]],
  ["R4", "fire_engine", "Engine-7", ["structural", "rescue", "ems_first_response"]],
  ["R5", "fire_engine", "Ladder-2", ["aerial", "rescue", "ventilation"]],
  ["R6", "police", "Unit-12", ["patrol", "traffic_control"]],
  ["R7", "police", "Unit-15", ["patrol", "investigation"]],
  ["R8", "hazmat_team", "HazMat-1", ["chemical", "biological", "radiological", "decon"]],
  ["R9", "helicopter", "LifeFlight-1", ["medevac", "search_rescue", "thermal_imaging"]],
  ["R10", "ems_supervisor", "EMS-Sup-1", ["mass_casualty", "triage_lead", "command"]],
  ["R11", "k9_unit", "K9-3", ["tracking", "narcotics", "explosives"]],
  ["R12", "swat", "TAC-1", ["tactical", "hostage_rescue", "high_risk_warrant"]],
];

function generateResources(): Resource[] {
  return RESOURCE_DEFS.map(([id, type, callsign, capabilities]) => ({
    id,
    type,
    callsign,
    capabilities,
    status: "available" as const,
    assignedIncident: null,
    eta: null,
  }));
}

export function createDefaultState(): DispatchState {
  return {
    incidents: {},
    resources: generateResources(),
    incidentCounter: 0,
    mutualAidCounter: 0,
    alertLevel: "green",
    mutualAidRequested: false,
  };
}

/** The session's live dispatch state. Mutations to the returned object
 *  stick — it is the object stored in `ctx.state`. */
export function getState(ctx: ToolContext): DispatchState {
  const slot = ctx.state as StateSlot;
  slot.dispatch ??= createDefaultState();
  return slot.dispatch;
}

// ─── Serialized state updates ────────────────────────────────────────────────

/**
 * Growth caps. The whole dispatch state is one object whose summaries feed
 * both the LLM and the dashboard event, so resolved incidents and long
 * timelines must be pruned or a long session's payloads grow without bound.
 */
const MAX_RESOLVED_KEPT = 10;
const MAX_TIMELINE_ENTRIES = 50;

function pruneState(state: DispatchState): void {
  const resolved = Object.values(state.incidents)
    .filter((i) => i.status === "resolved")
    .sort((a, b) => b.updatedAt - a.updatedAt);
  for (const inc of resolved.slice(MAX_RESOLVED_KEPT)) {
    delete state.incidents[inc.id];
  }
  for (const inc of Object.values(state.incidents)) {
    if (inc.timeline.length > MAX_TIMELINE_ENTRIES) {
      inc.timeline = inc.timeline.slice(-MAX_TIMELINE_ENTRIES);
    }
  }
}

const sessionLock = createKeyedLock();

/**
 * Serialized update of the session's dispatch state.
 *
 * The LLM loop executes parallel tool calls concurrently. The state lives in
 * `ctx.state` now (one shared object, no snapshot/save round-trip), but a
 * mutator may be async, and two interleaving async mutators can each observe
 * the other's half-applied changes. Holding the session's key makes each
 * update run against the previous one's finished result. It also centralizes
 * the shared bookkeeping every mutating tool needs: pruning and alert-level
 * recalculation.
 *
 * `createKeyedLock` rather than a hand-rolled promise chain per session: the
 * SDK's drops each key's entry once its chain drains (so a long-running agent
 * does not accumulate one per session id) and does it by ownership, which is
 * the part a hand-rolled chain gets wrong.
 *
 * There is no post-save callback: pushing the board to the client used to
 * need one, and `syncState` now does it after every tool call.
 */
export function updateState<R>(
  ctx: ToolContext,
  mutator: (state: DispatchState) => R | Promise<R>,
): Promise<R> {
  return withLock(sessionLock, ctx.sessionId, async () => {
    const state = getState(ctx);
    const result = await mutator(state);
    pruneState(state);
    recalculateAlertLevel(state);
    return result;
  });
}

// ─── Incident helpers ────────────────────────────────────────────────────────

export function createIncident(state: DispatchState, overrides: Partial<Incident>): Incident {
  state.incidentCounter++;
  const id = `INC-${String(state.incidentCounter).padStart(4, "0")}`;
  const time = Date.now();
  const incident: Incident = {
    id,
    type: "other",
    severity: "moderate",
    status: "incoming",
    location: "Unknown",
    description: "",
    callerName: "Unknown",
    callerPhone: "Unknown",
    triageScore: 0,
    assignedResources: [],
    timeline: [],
    createdAt: time,
    updatedAt: time,
    escalationLevel: 0,
    protocolsActivated: [],
    casualties: { confirmed: 0, estimated: 0, treated: 0 },
    hazards: [],
    ...overrides,
  };
  state.incidents[id] = incident;
  return incident;
}

export function findIncident(
  state: DispatchState,
  incidentId: string,
): Incident | { error: string } {
  return state.incidents[incidentId] ?? { error: `Incident ${incidentId} not found` };
}

/** Append a timeline entry and touch `updatedAt`. */
export function logEvent(inc: Incident, event: string): void {
  const time = Date.now();
  inc.timeline.push({ time, event });
  inc.updatedAt = time;
}

/** Minutes since the incident was created, rounded. */
export function incidentAgeMinutes(inc: Incident): number {
  return Math.round((Date.now() - inc.createdAt) / 60_000);
}

/** A resource as tool results describe it to the LLM. */
export function resourceBrief(r: Resource): {
  callsign: string;
  type: Resource["type"];
  capabilities: string[];
} {
  return { callsign: r.callsign, type: r.type, capabilities: r.capabilities };
}

/**
 * Status-transition guard. `resolved` is terminal: a resolved incident's
 * resources have been released (and possibly reassigned), so escalating,
 * re-resolving, or dispatching to it would corrupt resource assignments.
 */
export function assertNotResolved(inc: Incident, action: string): { error: string } | null {
  if (inc.status === "resolved") {
    return {
      error: `Incident ${inc.id} is resolved — cannot ${action}. Create a new incident if the situation has reopened.`,
    };
  }
  return null;
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
  natural_disaster: 1.8,
  utility: 0.8,
  other: 0.7,
};

export function calculateTriageScore(
  severity: Severity,
  type: IncidentType,
  casualties: number,
  hazards: number,
): number {
  let score = SEVERITY_WEIGHTS[severity] * TYPE_MULTIPLIERS[type];
  score += Math.min(casualties * 15, 60);
  score += Math.min(hazards * 10, 30);
  return Math.round(Math.max(0, Math.min(score, 250)));
}

const SEVERITY_KEYWORDS: [Severity, string[]][] = [
  [
    "critical",
    [
      "unconscious",
      "not breathing",
      "cardiac arrest",
      "trapped",
      "collapse",
      "explosion",
      "active shooter",
      "mass casualty",
    ],
  ],
  [
    "urgent",
    [
      "bleeding",
      "chest pain",
      "difficulty breathing",
      "fire",
      "hazmat",
      "shooting",
      "stabbing",
      "multi-vehicle",
    ],
  ],
  ["moderate", ["fall", "broken", "fracture", "smoke", "minor fire", "assault", "theft"]],
];

export function recommendSeverity(description: string): Severity {
  const d = description.toLowerCase();
  for (const [sev, kws] of SEVERITY_KEYWORDS) {
    if (kws.some((k) => d.includes(k))) return sev;
  }
  return "minor";
}

const TYPE_KEYWORDS: Record<IncidentType, string[]> = {
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
  hazmat: ["chemical", "spill", "gas leak", "fumes", "radiation", "contamination", "hazmat"],
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
  natural_disaster: [
    "earthquake",
    "flood",
    "tornado",
    "hurricane",
    "landslide",
    "wildfire",
    "tsunami",
  ],
  utility: ["power outage", "downed line", "water main", "gas main", "transformer"],
  other: [],
};

export function recommendType(description: string): IncidentType {
  const d = description.toLowerCase();
  let best: IncidentType = "other";
  let bestCount = 0;
  for (const [type, keywords] of Object.entries(TYPE_KEYWORDS)) {
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
      "Request mutual aid if >10 casualties",
      "Set up triage: Immediate (red), Delayed (yellow), Minor (green), Deceased (black)",
      "Assign triage lead (EMS supervisor)",
      "Establish patient collection point",
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
      "Confirm water supply",
      "Search and rescue primary sweep",
      "Ventilation operations",
      "Establish RIT (Rapid Intervention Team)",
      "Request additional alarms if not contained in 10 min",
    ],
    requiredResources: ["fire_engine"],
  },
  {
    name: "Hazardous Materials Response",
    triggers: { types: ["hazmat"], minSeverity: "moderate" },
    steps: [
      "Identify substance via placard numbers or SDS",
      "Establish hot, warm, and cold zones",
      "Evacuate downwind 1000+ feet for unknowns",
      "Deploy HazMat team in appropriate PPE",
      "Set up decontamination corridor",
      "Monitor air quality and wind continuously",
      "Coordinate with poison control",
    ],
    requiredResources: ["hazmat_team", "fire_engine", "ambulance"],
  },
  {
    name: "Active Threat / Active Shooter",
    triggers: { types: ["crime"], minSeverity: "critical" },
    steps: [
      "Dispatch SWAT and multiple patrol units",
      "Establish inner and outer perimeters",
      "Activate Rescue Task Force — police escort EMS into warm zone",
      "Stage ambulances outside hot zone",
      "Request LifeFlight on standby",
      "Get building floor plans",
      "Establish family reunification point",
    ],
    requiredResources: ["swat", "police", "ambulance", "ems_supervisor"],
  },
  {
    name: "Multi-Vehicle Accident",
    triggers: { types: ["traffic"], minSeverity: "urgent" },
    steps: [
      "Dispatch engine for extrication",
      "Request traffic control to shut lanes",
      "Triage using START protocol",
      "Check for fuel/hazmat spills",
      "Establish helicopter landing zone if needed",
      "Coordinate with DOT for road closures",
    ],
    requiredResources: ["fire_engine", "ambulance", "police"],
  },
  {
    name: "Cardiac Arrest Protocol",
    triggers: { types: ["medical"], minSeverity: "critical" },
    steps: [
      "Instruct caller: CPR — 30 compressions, 2 breaths",
      "Dispatch closest ALS unit and fire engine",
      "Guide caller through AED use if available",
      "Target first defibrillation under 8 minutes",
      "Prepare for advanced airway management",
    ],
    requiredResources: ["ambulance", "fire_engine"],
  },
];

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  urgent: 3,
  moderate: 2,
  minor: 1,
};

export function getApplicableProtocols(type: IncidentType, severity: Severity): Protocol[] {
  return PROTOCOLS.filter(
    (p) =>
      p.triggers.types.includes(type) &&
      SEVERITY_RANK[severity] >= SEVERITY_RANK[p.triggers.minSeverity],
  );
}

// ─── Resource recommendation engine ──────────────────────────────────────────

const BASE_NEEDS: Record<IncidentType, Resource["type"][]> = {
  medical: ["ambulance"],
  fire: ["fire_engine", "ambulance"],
  hazmat: ["hazmat_team", "fire_engine", "ambulance"],
  traffic: ["police", "ambulance", "fire_engine"],
  crime: ["police"],
  natural_disaster: ["fire_engine", "ambulance", "police"],
  utility: ["fire_engine"],
  other: [],
};

export function recommendResources(
  type: IncidentType,
  severity: Severity,
  state: DispatchState,
): Resource[] {
  const needed: Resource["type"][] = [];

  needed.push(...(BASE_NEEDS[type] || []));

  if (severity === "critical") {
    if (!needed.includes("ambulance")) needed.push("ambulance");
    needed.push("ems_supervisor");
    if (type === "crime") needed.push("swat");
  }
  if (severity === "urgent" && type === "fire") {
    needed.push("fire_engine");
  }

  const recommended: Resource[] = [];
  const usedIds = new Set<string>();

  for (const needType of needed) {
    const available = state.resources.find(
      (r) => r.type === needType && r.status === "available" && !usedIds.has(r.id),
    );
    if (available) {
      recommended.push(available);
      usedIds.add(available.id);
    }
  }

  return recommended;
}

// ─── System alert level calculation ──────────────────────────────────────────

/** Fraction of resources not currently available, 0–1. The alert level and
 *  the dashboard's displayed utilization both derive from this, so they can
 *  never disagree about what "utilization" means. */
export function resourceUtilization(state: DispatchState): number {
  const available = state.resources.filter((r) => r.status === "available").length;
  return 1 - available / state.resources.length;
}

export function recalculateAlertLevel(state: DispatchState): void {
  const activeIncidents = Object.values(state.incidents).filter((i) => i.status !== "resolved");
  const criticalCount = activeIncidents.filter((i) => i.severity === "critical").length;
  const totalActive = activeIncidents.length;
  const utilization = resourceUtilization(state);

  if (criticalCount >= 3 || utilization > 0.85 || totalActive >= 8) {
    state.alertLevel = "red";
  } else if (criticalCount >= 2 || utilization > 0.65 || totalActive >= 5) {
    state.alertLevel = "orange";
  } else if (criticalCount >= 1 || utilization > 0.4 || totalActive >= 3) {
    state.alertLevel = "yellow";
  } else {
    state.alertLevel = "green";
  }

  // Mutual aid tracks system posture: requested at red alert, stood down
  // when the alert level drops back below red.
  state.mutualAidRequested = state.alertLevel === "red";
}
