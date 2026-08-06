// Dispatch domain logic — a plain-JavaScript port of the dispatch-center
// template's `shared.ts`. No SDK, no zod, no build step. This module holds
// the pure scoring/protocol/resource engines plus an in-memory KV store that
// mirrors the `{ get, set, delete }` interface the original tools expect.

// ─── In-memory KV (with optional localStorage persistence) ───────────────────
//
// The managed platform gives each agent a real KV store. Here we recreate the
// same async surface with a Map, persisted to localStorage so operational
// state survives a page reload — exactly like the "Restoring operational
// state" line in the agent greeting.

const KV_PREFIX = "dispatch-vanilla:";

export function createKv() {
  /** @type {Map<string, unknown>} */
  const mem = new Map();

  // Hydrate from localStorage if available.
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const storageKey = localStorage.key(i);
      if (storageKey && storageKey.startsWith(KV_PREFIX)) {
        const key = storageKey.slice(KV_PREFIX.length);
        mem.set(key, JSON.parse(localStorage.getItem(storageKey)));
      }
    }
  } catch {
    /* localStorage unavailable — stay purely in-memory */
  }

  function persist(key, value) {
    try {
      localStorage.setItem(KV_PREFIX + key, JSON.stringify(value));
    } catch {
      /* ignore quota / unavailable */
    }
  }
  function unpersist(key) {
    try {
      localStorage.removeItem(KV_PREFIX + key);
    } catch {
      /* ignore */
    }
  }

  return {
    async get(key) {
      return mem.has(key) ? structuredClone(mem.get(key)) : null;
    },
    async set(key, value) {
      const cloned = structuredClone(value);
      mem.set(key, cloned);
      persist(key, cloned);
    },
    async delete(key) {
      mem.delete(key);
      unpersist(key);
    },
    /** Wipe all dispatch state (used by the Reset button). */
    async clear() {
      for (const key of mem.keys()) unpersist(key);
      mem.clear();
    },
  };
}

export const STATE_KEY = "dispatch:state";
export const INCIDENT_INDEX_KEY = "incident-index";

// ─── Resource generation ─────────────────────────────────────────────────────

/** @type {[string, string, string, string[]][]} */
const RESOURCE_DEFS = [
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

function generateResources() {
  return RESOURCE_DEFS.map(([id, type, callsign, capabilities]) => ({
    id,
    type,
    callsign,
    capabilities,
    status: "available",
    assignedIncident: null,
    eta: null,
  }));
}

export function createDefaultState() {
  return {
    incidents: {},
    resources: generateResources(),
    incidentCounter: 0,
    alertLevel: "green",
    mutualAidRequested: false,
  };
}

export async function getState(kv) {
  const saved = await kv.get(STATE_KEY);
  return saved ?? createDefaultState();
}

export async function saveState(kv, state) {
  await kv.set(STATE_KEY, state);
}

export async function saveIncidentSnapshot(kv, incident) {
  await kv.set(`incident:${incident.id}`, incident);
  const index = (await kv.get(INCIDENT_INDEX_KEY)) ?? [];
  if (!index.includes(incident.id)) {
    index.push(incident.id);
    await kv.set(INCIDENT_INDEX_KEY, index);
  }
}

export async function deleteIncidentSnapshot(kv, incidentId) {
  await kv.delete(`incident:${incidentId}`);
  const index = (await kv.get(INCIDENT_INDEX_KEY)) ?? [];
  await kv.set(
    INCIDENT_INDEX_KEY,
    index.filter((id) => id !== incidentId),
  );
}

// ─── Triage & scoring ──────────────────────────────────────────────────────────

const SEVERITY_WEIGHTS = { critical: 100, urgent: 70, moderate: 40, minor: 10 };

const TYPE_MULTIPLIERS = {
  medical: 1.2,
  fire: 1.3,
  hazmat: 1.5,
  traffic: 1.0,
  crime: 1.1,
  natural_disaster: 1.8,
  utility: 0.8,
  other: 0.7,
};

export function calculateTriageScore(severity, type, casualties, hazards) {
  let score = SEVERITY_WEIGHTS[severity] * TYPE_MULTIPLIERS[type];
  score += Math.min(casualties * 15, 60);
  score += Math.min(hazards * 10, 30);
  return Math.round(Math.min(score, 250));
}

const SEVERITY_KEYWORDS = [
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

export function recommendSeverity(description) {
  const d = description.toLowerCase();
  for (const [sev, kws] of SEVERITY_KEYWORDS) {
    if (kws.some((k) => d.includes(k))) return sev;
  }
  return "minor";
}

const TYPE_KEYWORDS = {
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
  traffic: ["accident", "crash", "collision", "vehicle", "rollover", "pedestrian struck", "hit and run"],
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
  natural_disaster: ["earthquake", "flood", "tornado", "hurricane", "landslide", "wildfire", "tsunami"],
  utility: ["power outage", "downed line", "water main", "gas main", "transformer"],
  other: [],
};

export function recommendType(description) {
  const d = description.toLowerCase();
  let best = "other";
  let bestCount = 0;
  for (const [type, keywords] of Object.entries(TYPE_KEYWORDS)) {
    const count = keywords.filter((k) => d.includes(k)).length;
    if (count > bestCount) {
      bestCount = count;
      best = type;
    }
  }
  return best;
}

// ─── Protocol engine ───────────────────────────────────────────────────────────

export const PROTOCOLS = [
  {
    name: "Mass Casualty Incident (MCI)",
    triggers: { types: ["medical", "fire", "natural_disaster", "traffic"], minSeverity: "critical" },
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

export function getApplicableProtocols(type, severity) {
  const severityRank = { critical: 4, urgent: 3, moderate: 2, minor: 1 };
  return PROTOCOLS.filter(
    (p) => p.triggers.types.includes(type) && severityRank[severity] >= severityRank[p.triggers.minSeverity],
  );
}

// ─── Resource recommendation engine ─────────────────────────────────────────────

export function recommendResources(type, severity, state) {
  const needed = [];

  const baseNeeds = {
    medical: ["ambulance"],
    fire: ["fire_engine", "ambulance"],
    hazmat: ["hazmat_team", "fire_engine", "ambulance"],
    traffic: ["police", "ambulance", "fire_engine"],
    crime: ["police"],
    natural_disaster: ["fire_engine", "ambulance", "police"],
    utility: ["fire_engine"],
    other: [],
  };

  needed.push(...(baseNeeds[type] || []));

  if (severity === "critical") {
    if (!needed.includes("ambulance")) needed.push("ambulance");
    needed.push("ems_supervisor");
    if (type === "crime") needed.push("swat");
  }
  if (severity === "urgent" && type === "fire") {
    needed.push("fire_engine");
  }

  const recommended = [];
  const usedIds = new Set();

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

// ─── System alert level calculation ──────────────────────────────────────────────

export function recalculateAlertLevel(state) {
  const activeIncidents = Object.values(state.incidents).filter((i) => !["resolved"].includes(i.status));
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

export function now() {
  return Date.now();
}
