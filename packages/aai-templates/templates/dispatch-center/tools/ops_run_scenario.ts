import { tool } from "@alexkroman1/aai";
import { z } from "zod";
import type { Incident, IncidentType, Severity } from "../shared.ts";
import {
  calculateTriageScore,
  createIncident,
  getState,
  recalculateAlertLevel,
  saveState,
} from "../shared.ts";

type ScenarioDef = { narrative: string; incidents: Partial<Incident>[] };

const inc = (
  location: string,
  description: string,
  type: IncidentType,
  severity: Severity,
): Partial<Incident> => ({ location, description, type, severity });

const scenarios: Record<string, ScenarioDef> = {
  mass_casualty: {
    narrative:
      "Bus crash at Main and 5th. School bus vs delivery truck. Multiple pediatric patients. Fuel spill.",
    incidents: [
      inc(
        "Main St and 5th Ave intersection",
        "School bus collision with delivery truck, multiple children injured, bus on its side, fuel leaking",
        "traffic",
        "critical",
      ),
      inc(
        "Main St and 5th Ave — fuel spill",
        "Diesel fuel spill from delivery truck spreading toward storm drain, ~50 gallons",
        "hazmat",
        "urgent",
      ),
    ],
  },
  multi_alarm_fire: {
    narrative:
      "Working structure fire at 200 Industrial Parkway. 3-story warehouse, heavy smoke. Workers possibly trapped.",
    incidents: [
      inc(
        "200 Industrial Parkway",
        "3-story warehouse fully involved, possible trapped occupants on 2nd/3rd floor",
        "fire",
        "critical",
      ),
      inc(
        "200 Industrial Parkway — medical",
        "2 workers with smoke inhalation, one with burns",
        "medical",
        "urgent",
      ),
    ],
  },
  active_shooter: {
    narrative:
      "Active shooter at Riverside Mall. Multiple shots fired, crowds fleeing. At least 3 victims down in food court.",
    incidents: [
      inc(
        "Riverside Mall, 1500 River Road — food court",
        "Active shooter, multiple shots, at least 3 victims down, shooter moving toward west entrance",
        "crime",
        "critical",
      ),
      inc(
        "Riverside Mall parking lot",
        "Crowd crush injuries, several trampled near east exit",
        "medical",
        "urgent",
      ),
    ],
  },
  natural_disaster: {
    narrative:
      "EF-3 tornado in residential area. Oak Street corridor. Multiple structures collapsed. Power lines down.",
    incidents: [
      inc(
        "Oak Street between 10th and 15th",
        "Tornado damage, homes collapsed, people trapped, gas lines ruptured",
        "natural_disaster",
        "critical",
      ),
      inc(
        "Oak Street Elementary School",
        "School roof partially collapsed, staff sheltering students",
        "natural_disaster",
        "critical",
      ),
      inc(
        "Oak Street and 12th — utility",
        "Downed power lines sparking, gas main rupture, area needs isolation",
        "utility",
        "urgent",
      ),
    ],
  },
  highway_pileup: {
    narrative:
      "20+ vehicle pileup on I-95 southbound mile marker 42. Fog. Multiple entrapments. Tanker truck involved.",
    incidents: [
      inc(
        "I-95 southbound mile marker 42",
        "Multi-vehicle pileup, 20+ vehicles, multiple entrapments, tanker with unknown cargo, heavy fog",
        "traffic",
        "critical",
      ),
      inc(
        "I-95 southbound — hazmat",
        "Tanker leaking unknown liquid, placards not visible, exclusion zone being set up",
        "hazmat",
        "critical",
      ),
    ],
  },
};

export const opsRunScenario = tool({
  description: "Run a training scenario that creates simulated incidents for dispatch practice.",
  parameters: z.object({
    scenario: z
      .enum([
        "mass_casualty",
        "multi_alarm_fire",
        "active_shooter",
        "natural_disaster",
        "highway_pileup",
      ])
      .describe("Scenario type to simulate"),
  }),
  async execute(args, ctx) {
    const state = await getState(ctx.kv);

    const s = scenarios[args.scenario];
    if (!s) return { error: "Unknown scenario" };

    const created: string[] = [];
    for (const scenarioInc of s.incidents) {
      const fullInc = createIncident(state, {
        type: scenarioInc.type || "other",
        severity: scenarioInc.severity || "moderate",
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
        timeline: [
          {
            time: Date.now(),
            event: `SCENARIO: ${scenarioInc.description}`,
          },
        ],
      });
      created.push(fullInc.id);
    }

    recalculateAlertLevel(state);
    await saveState(ctx.kv, state);

    return {
      scenario: args.scenario,
      narrative: s.narrative,
      incidentsCreated: created,
      systemAlertLevel: state.alertLevel,
      message: `SCENARIO ACTIVE: ${s.narrative}. ${created.length} incidents created. Awaiting dispatch orders.`,
    };
  },
});
