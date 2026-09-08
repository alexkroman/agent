import { agent } from "@alexkroman1/aai";
import { DISPATCH_EVENTS } from "./events.ts";
import { callFlow, dashboardProjection } from "./shared.ts";

export default agent({
  name: "Dispatch Command Center",

  /**
   * Declaring the flow is what makes its instructions reach a turn that calls
   * nothing.
   *
   * `callFlow` gated its six tools without this line and still would — what the
   * declaration adds is the half no tool call can reach: the active state's
   * `instruction` is appended to the system prompt on EVERY turn. That matters
   * here more than the gate does, because this template moved the sequencing
   * out of `system-prompt.md` and into the states ("confirm the severity",
   * "never leave a critical incident without at least one unit"). A dispatcher
   * spends most turns talking to a caller rather than calling tools, and
   * without this those sentences reached the model only on the turns that
   * happened to run a gated tool — which is to say, only after it had already
   * decided what to do.
   */
  dialogs: [callFlow],
  // The board exists before the first tool call, so a resumed connection has
  // something to project rather than an empty state object.
  // One projection replaces eleven `ctx.send("incidents", ...)` calls, and
  // is the single place that decides caller PII stays server-side.
  syncState: dashboardProjection,
  // A dispatcher reads addresses and unit numbers in bursts with pauses inside
  // one message ("unit twelve … respond to"). The default pipeline's
  // `max_turn_silence` already tolerates that; reach for
  // `assemblyAIStt({ maxTurnSilenceMs })` only if your callers pause longer.
  greeting:
    "Dispatch Command Center online. Restoring operational state. I'm ready to take incoming calls, manage active incidents, or run dispatch operations. Say 'dashboard' for a full status report. What do we have.",

  /**
   * A dropped 911 call, written on the incident it belongs to.
   *
   * The pairing with `dialogs` above is the contrast worth reading: on a phone
   * desk the same event MOVES the dialog into a terminal state, and here it
   * moves nothing — the shift outlives the caller. See `events.ts`.
   */
  events: DISPATCH_EVENTS,

  // The system prompt instructs the model to use web_search and run_code, so
  // they must be enabled here — the default builtin set does not include them.
  builtinTools: ["think", "remember", "recall", "calculate", "web_search", "run_code"],
});
