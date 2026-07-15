// ─── Types ───────────────────────────────────────────────────────────────────

import type { Kv } from "@alexkroman1/aai";

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
  notes: string[];
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
  alertLevel: "green" | "yellow" | "orange" | "red";
  mutualAidRequested: boolean;
}

// ─── KV helpers ──────────────────────────────────────────────────────────────

export const STATE_KEY = "dispatch:state";
export const INCIDENT_INDEX_KEY = "incident-index";

export function incidentKey(incidentId: string): string {
  return `incident:${incidentId}`;
}

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
    alertLevel: "green",
    mutualAidRequested: false,
  };
}

export async function getState(kv: Kv): Promise<DispatchState> {
  const saved = await kv.get<DispatchState>(STATE_KEY);
  return saved ?? createDefaultState();
}

export async function saveState(kv: Kv, state: DispatchState): Promise<void> {
  await kv.set(STATE_KEY, state);
}

export async function saveIncidentSnapshot(kv: Kv, incident: Incident): Promise<void> {
  const [, index] = await Promise.all([
    kv.set(incidentKey(incident.id), incident),
    kv.get<string[]>(INCIDENT_INDEX_KEY),
  ]);
  const ids = index ?? [];
  if (!ids.includes(incident.id)) {
    ids.push(incident.id);
    await kv.set(INCIDENT_INDEX_KEY, ids);
  }
}

export async function deleteIncidentSnapshot(kv: Kv, incidentId: string): Promise<void> {
  const [, index] = await Promise.all([
    kv.delete(incidentKey(incidentId)),
    kv.get<string[]>(INCIDENT_INDEX_KEY),
  ]);
  const updated = (index ?? []).filter((id) => id !== incidentId);
  await kv.set(INCIDENT_INDEX_KEY, updated);
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
    notes: [],
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
  return Math.round(Math.min(score, 250));
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

export interface Protocol {
  name: string;
  triggers: { types: IncidentType[]; minSeverity: Severity };
  steps: string[];
  requiredResources: Resource["type"][];
}

export const PROTOCOLS: Protocol[] = [
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

export function recalculateAlertLevel(state: DispatchState): void {
  const activeIncidents = Object.values(state.incidents).filter((i) => i.status !== "resolved");
  const criticalCount = activeIncidents.filter((i) => i.severity === "critical").length;
  const totalActive = activeIncidents.length;
  const availableResources = state.resources.filter((r) => r.status === "available").length;
  const totalResources = state.resources.length;
  const resourceUtilization = 1 - availableResources / totalResources;

  if (criticalCount >= 3 || resourceUtilization > 0.85 || totalActive >= 8) {
    state.alertLevel = "red";
  } else if (criticalCount >= 2 || resourceUtilization > 0.65 || totalActive >= 5) {
    state.alertLevel = "orange";
  } else if (criticalCount >= 1 || resourceUtilization > 0.4 || totalActive >= 3) {
    state.alertLevel = "yellow";
  } else {
    state.alertLevel = "green";
  }

  if (state.alertLevel === "red" && !state.mutualAidRequested) {
    state.mutualAidRequested = true;
  }
}
