// ─── Types ───────────────────────────────────────────────────────────────────

import type { DeepReadonly, ToolFailure } from "@alexkroman1/aai";
import { dialog, pushCapped, sessionSlot } from "@alexkroman1/aai";

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
  casualties: { confirmed: number; estimated: number; treated: number };
  hazards: string[];
}

export interface DispatchState {
  incidents: Record<string, Incident>;
  resources: Resource[];
  incidentCounter: number;
  mutualAidCounter: number;
  alertLevel: "green" | "yellow" | "orange" | "red";
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

export function incidentSummary(inc: DeepReadonly<Incident>): IncidentSummary {
  return { id: inc.id, severity: inc.severity, status: inc.status, location: inc.location };
}

/** One incident as the browser sees it — see `dashboardView`. */
export interface DashboardView {
  systemAlertLevel: DispatchState["alertLevel"];
  incidents: IncidentSummary[];
}

/** The `syncState` projection — the whole contract with client.tsx. Takes the
 *  board itself, not the slot: `dispatchSlot.projection` supplies a real one
 *  even before the first tool call. */
export function dashboardView(state: FrozenDispatchState): DashboardView {
  return {
    systemAlertLevel: state.alertLevel,
    incidents: Object.values(state.incidents).map(incidentSummary),
  };
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
    mutualAidCounter: 0,
    alertLevel: "green",
  };
}

// ─── State helpers ───────────────────────────────────────────────────────────
// The dispatch board lives in one `sessionSlot`, keyed per session — sessions
// must not see each other's incidents, and a slot gives that isolation by
// construction.

/**
 * Growth caps. The whole dispatch state is one object whose summaries feed
 * both the LLM and the dashboard event, so resolved incidents and long
 * timelines must be pruned or a long session's payloads grow without bound.
 */
const MAX_RESOLVED_KEPT = 10;
export const MAX_TIMELINE_ENTRIES = 50;

/** Resolved incidents only — the timeline cap is held on append by
 *  `logEvent`, so nothing here has to re-trim it. */
function pruneState(state: DispatchState): void {
  const resolved = Object.values(state.incidents)
    .filter((i) => i.status === "resolved")
    .sort((a, b) => b.updatedAt - a.updatedAt);
  for (const inc of resolved.slice(MAX_RESOLVED_KEPT)) {
    delete state.incidents[inc.id];
  }
}

/**
 * The session's dispatch board, as one typed slot.
 *
 * Every tool here is declared through the slot rather than reaching for it from
 * inside a `tool()` body, and WHICH HALF is the whole decision: `updateTool`
 * runs the body inside the mutation window and hands it a draft that is stored
 * when the body returns, `tool` hands it the deep-frozen stored value. That
 * makes "does this tool write?" a property of the declaration a reader can see,
 * and choosing wrong a compile error rather than a `TypeError` on the first
 * call.
 *
 * The window is SYNCHRONOUS, which is what makes a read-modify-write atomic
 * with no lock — the LLM loop runs a step's tool calls concurrently. It does
 * NOT serialize anything (an earlier version of this comment claimed it did):
 * there is nothing to serialize, because no other JS turn can interleave with
 * a synchronous body. `updateTool` is what enforces the rule, refusing a
 * thenable body by name.
 *
 * `after` is the bookkeeping every mutating tool needs and none of them should
 * have to remember — pruning resolved incidents, and recalculating the alert
 * level the dashboard reads. Declaring it here rather than at each call site is
 * the point: a new mutating tool gets both for free.
 */
export const dispatchSlot = sessionSlot("dispatch", createDefaultState, {
  after: (state) => {
    pruneState(state);
    recalculateAlertLevel(state);
  },
});

/** The projection BOTH ends use: `syncState` on the agent, `useAgentState` in the client. */
export const dashboardProjection = dispatchSlot.projection(dashboardView);

// ─── The call in hand ────────────────────────────────────────────────────────

/**
 * Where the dispatcher is on the call in hand, as a plain state map.
 *
 * Declared as a {@link DialogSpec} — `{ initial, states }`, each state carrying
 * its own `instruction` and `on` map — rather than an XState machine. This
 * dialog used exactly the four things a spec can say, and the `setup({ types:
 * {} as { events: … } })` block it used to carry restated the four event names
 * already written in the `on` maps below. The instruction is a TYPED field now
 * instead of an untyped `meta` bag, which matters because a misspelling there
 * produced a refusal with no recovery text and no error anywhere.
 *
 * The system prompt used to carry this as prose — "incident_triage: After
 * creating, assess severity", "Critical incidents get immediate dispatch",
 * "Never leave a critical incident without at least one resource dispatched" —
 * which is advice to a model rather than a property of the agent. Two things
 * change by declaring it.
 *
 * **The gate is real.** Six mutating tools take an incident id and did their own
 * "does this exist" check through {@link findIncident}, whose answer on an empty
 * board is `Incident INC-0001 not found` — a data answer to a positional
 * question, and the wrong sentence for a dispatcher who has logged nothing yet.
 * `when: "working"` is that check now, and the SDK's refusal names where the
 * shift actually is and quotes the state's instruction.
 *
 * **The instruction rides every result.** A flow tool answers with the position
 * it landed in, so `incident_create`'s result now ends with "confirm the
 * severity and type with incident_triage" and `incident_triage`'s with "assign
 * units" — the tool-by-tool sequencing the prompt was spending paragraphs on,
 * arriving in the last thing the model reads before it speaks.
 *
 * **What this position is NOT is per-incident.** A flow is bound to a session
 * and holds one position, and this board holds many incidents at once — so
 * `working.monitoring` means "the incident this dispatcher last touched has
 * units on it", not "every incident does". Per-incident status stays where it
 * belongs, on {@link Incident.status}, and the tools stay addressed by id. That
 * is also why `working` is a PARENT state: what every gated tool actually needs
 * is "something has been logged on this shift", and the three children exist to
 * carry the instruction for the step in front of the dispatcher rather than to
 * gate anything.
 *
 * `LOGGED` is accepted from every state because a new 911 call is always legal —
 * the one transition that is not a progression.
 *
 * `as const` is what keeps the `on` keys literal, so `DialogEvent` synthesizes
 * the event union from them and a misspelled `send` is a compile error.
 */
const callSpec = {
  initial: "standby",
  states: {
    standby: {
      instruction:
        "Nothing is logged on this shift. Take the call — location first, then the " +
        "nature of the emergency, then the caller's name and callback — and log it " +
        "with incident_create.",
      on: { LOGGED: "working" },
    },
    working: {
      initial: "triaging",
      // Declared on the PARENT so all three children inherit it, which is what
      // makes a new call legal mid-incident without repeating the transition
      // three times. The children re-target each other below.
      on: { LOGGED: ".triaging" },
      states: {
        triaging: {
          instruction:
            "Logged, not yet triaged. Confirm or override the severity and type with " +
            "incident_triage. For a critical call, dispatch first and triage alongside it.",
          on: { TRIAGED: "dispatching", DISPATCHED: "monitoring", ESCALATED: "dispatching" },
        },
        dispatching: {
          instruction:
            "Triaged, nothing rolling. Assign units with resources_dispatch — never " +
            "leave a critical incident without at least one.",
          on: { DISPATCHED: "monitoring", TRIAGED: "dispatching", ESCALATED: "dispatching" },
        },
        monitoring: {
          instruction:
            "Units are assigned. Work it — status updates as they radio in, notes as " +
            "the picture changes, escalate if it outgrows the response, and close it " +
            "with incident_update_status.",
          on: { TRIAGED: "dispatching", DISPATCHED: "monitoring", ESCALATED: "dispatching" },
        },
      },
    },
  },
} as const;

/**
 * The flow. Its own slot key beside {@link dispatchSlot}: the flow holds the
 * POSITION and the board holds the incidents, because the position is one fact
 * about the conversation and the board is many facts about the world. One tool
 * call moves both — every converted tool opens `dispatchSlot.update` inside its
 * `execute` and lets the flow's own `send` follow it.
 */
export const callFlow = dialog("call", callSpec);

/**
 * The board as a READ hands it out: deep-frozen, and typed to say so.
 *
 * The pure helpers below take this rather than {@link DispatchState}, which is
 * the widening a deep-readonly slot forces and the reason it is worth doing: a
 * mutable board still satisfies it, so a helper called with an `updateTool`
 * draft is unaffected, while a helper that WOULD have mutated stops compiling
 * instead of throwing at its first call in production.
 */
export type FrozenDispatchState = DeepReadonly<DispatchState>;

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
    casualties: { confirmed: 0, estimated: 0, treated: 0 },
    hazards: [],
    ...overrides,
  };
  state.incidents[id] = incident;
  return incident;
}

/**
 * One incident by id, or the failure the model should read.
 *
 * Generic over the incident's own type rather than pinned to {@link Incident},
 * so ONE lookup serves both halves of the slot: a mutating tool passes its
 * draft and gets a mutable incident back to change, while `incident_get` passes
 * what `dispatchSlot.tool` handed it — deep-frozen — and gets a readonly one.
 * Pinning it would have made the read path the odd one out, and its way out
 * would have been a cast.
 */
export function findIncident<I extends DeepReadonly<Incident>>(
  state: { readonly incidents: { readonly [id: string]: I } },
  incidentId: string,
): I | ToolFailure {
  return state.incidents[incidentId] ?? { error: `Incident ${incidentId} not found` };
}

/** Append a timeline entry and touch `updatedAt`, holding
 *  {@link MAX_TIMELINE_ENTRIES}. Capped on APPEND rather than swept later, so
 *  a single long-running incident cannot outgrow the payload between sweeps. */
export function logEvent(inc: Incident, event: string): void {
  const time = Date.now();
  pushCapped(inc.timeline, { time, event }, MAX_TIMELINE_ENTRIES);
  inc.updatedAt = time;
}

/** Minutes since the incident was created, rounded. */
export function incidentAgeMinutes(inc: DeepReadonly<Incident>): number {
  return Math.round((Date.now() - inc.createdAt) / 60_000);
}

/** A resource as tool results describe it to the LLM. */
export function resourceBrief(r: DeepReadonly<Resource>): {
  callsign: string;
  type: Resource["type"];
  capabilities: string[];
} {
  // `capabilities` is COPIED: a brief is a fresh object handed to the LLM, and
  // the source list belongs either to a frozen slot value or to a live draft.
  return { callsign: r.callsign, type: r.type, capabilities: [...r.capabilities] };
}

/**
 * Status-transition guard. `resolved` is terminal: a resolved incident's
 * resources have been released (and possibly reassigned), so escalating,
 * re-resolving, or dispatching to it would corrupt resource assignments.
 */
export function assertNotResolved(inc: DeepReadonly<Incident>, action: string): ToolFailure | null {
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
export function resourceUtilization(state: FrozenDispatchState): number {
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
}
