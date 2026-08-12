import { agent } from "@alexkroman1/aai";
import { afterAction, requestAfterAction } from "./after-action.ts";
import { dashboardView, dispatchSlot } from "./shared.ts";
import systemPrompt from "./system-prompt.md?raw";
import { incidentAddNote } from "./tools/incident_add_note.ts";
import { incidentCreate } from "./tools/incident_create.ts";
import { incidentEscalate } from "./tools/incident_escalate.ts";
import { incidentGet } from "./tools/incident_get.ts";
import { incidentTriage } from "./tools/incident_triage.ts";
import { incidentUpdateStatus } from "./tools/incident_update_status.ts";
import { opsDashboard } from "./tools/ops_dashboard.ts";
import { opsProtocols } from "./tools/ops_protocols.ts";
import { opsRunScenario } from "./tools/ops_run_scenario.ts";
import { resourcesDispatch } from "./tools/resources_dispatch.ts";
import { resourcesGetAvailable } from "./tools/resources_get_available.ts";
import { resourcesUpdateStatus } from "./tools/resources_update_status.ts";

export default agent({
  name: "Dispatch Command Center",
  // One projection replaces eleven `ctx.send("incidents", ...)` calls, and
  // is the single place that decides caller PII stays server-side.
  syncState: dispatchSlot.projection(dashboardView),
  // A dispatcher reads addresses and unit numbers in bursts with pauses inside
  // one message ("unit twelve … respond to"). The default pipeline's
  // `max_turn_silence` already tolerates that; reach for
  // `assemblyAIStt({ maxTurnSilenceMs })` only if your callers pause longer.
  systemPrompt,
  greeting:
    "Dispatch Command Center online. Restoring operational state. I'm ready to take incoming calls, manage active incidents, or run dispatch operations. Say 'dashboard' for a full status report. What do we have.",

  // The system prompt instructs the model to use web_search and run_code, so
  // they must be enabled here — the default builtin set does not include them.
  //
  // `workflow_status` is what makes the after-action report answerable: the run
  // outlives the call, so "is the report for four ready yet?" has to be readable
  // from the journal rather than from `ctx.state`. It reports only runs keyed to
  // THIS session, which is the key `startTool` sets by default.
  builtinTools: [
    "think",
    "remember",
    "recall",
    "calculate",
    "web_search",
    "run_code",
    "workflow_status",
  ],

  // Durable work this agent owns. Declared here rather than inferred from the
  // tool: this record is the single source of the name the journal records, so a
  // rename is one edit and a run started by an older bundle still resolves.
  workflows: { after_action: afterAction },

  tools: {
    after_action_report: requestAfterAction,
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
  },
});
