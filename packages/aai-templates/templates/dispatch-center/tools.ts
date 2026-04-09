import incident_add_note from "./tools/incident_add_note.ts";
import incident_create from "./tools/incident_create.ts";
import incident_escalate from "./tools/incident_escalate.ts";
import incident_get from "./tools/incident_get.ts";
import incident_triage from "./tools/incident_triage.ts";
import incident_update_status from "./tools/incident_update_status.ts";
import ops_dashboard from "./tools/ops_dashboard.ts";
import ops_protocols from "./tools/ops_protocols.ts";
import ops_run_scenario from "./tools/ops_run_scenario.ts";
import resources_dispatch from "./tools/resources_dispatch.ts";
import resources_get_available from "./tools/resources_get_available.ts";
import resources_update_status from "./tools/resources_update_status.ts";

export const tools = {
  incident_add_note,
  incident_create,
  incident_escalate,
  incident_get,
  incident_triage,
  incident_update_status,
  ops_dashboard,
  ops_protocols,
  ops_run_scenario,
  resources_dispatch,
  resources_get_available,
  resources_update_status,
};
