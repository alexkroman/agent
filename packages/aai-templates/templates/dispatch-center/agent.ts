import { agent } from "aai";
import systemPrompt from "./system-prompt.md";
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
  systemPrompt,
  greeting:
    "Dispatch Command Center online. Restoring operational state. I'm ready to take incoming calls, manage active incidents, or run dispatch operations. Say 'dashboard' for a full status report. What do we have.",

  tools: {
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
