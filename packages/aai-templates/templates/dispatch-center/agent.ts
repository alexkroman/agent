import { agent } from "@alexkroman1/aai";
import { dashboardView, dispatchSlot } from "./shared.ts";

export default agent({
  name: "Dispatch Command Center",
  // The board exists before the first tool call, so a resumed connection has
  // something to project rather than an empty state object.
  // One projection replaces eleven `ctx.send("incidents", ...)` calls, and
  // is the single place that decides caller PII stays server-side.
  syncState: dispatchSlot.projection(dashboardView),
  // A dispatcher reads addresses and unit numbers in bursts with pauses inside
  // one message ("unit twelve … respond to"). The default pipeline's
  // `max_turn_silence` already tolerates that; reach for
  // `assemblyAIStt({ maxTurnSilenceMs })` only if your callers pause longer.
  greeting:
    "Dispatch Command Center online. Restoring operational state. I'm ready to take incoming calls, manage active incidents, or run dispatch operations. Say 'dashboard' for a full status report. What do we have.",

  // The system prompt instructs the model to use web_search and run_code, so
  // they must be enabled here — the default builtin set does not include them.
  builtinTools: ["think", "remember", "recall", "calculate", "web_search", "run_code"],
});
