import { agent } from "@alexkroman1/aai";
import { DISPATCH_GUARDRAILS } from "./guardrails.ts";
import { callFlow, callInHand, dispatchSlot, logEvent } from "./shared.ts";

export default agent({
  name: "Dispatch Command Center",
  listing: "Runs a 911 dispatch shift: logs incidents, triages them, and assigns units",
  syncState: dispatchSlot.projected,
  // The flow gates its tools whether or not it is declared here. Declaring it
  // puts the active state's instruction in front of the model on EVERY turn —
  // and a dispatcher spends most turns talking to a caller, not calling tools.
  dialogs: [callFlow],
  // A dispatcher reads addresses and unit numbers in bursts with pauses inside
  // one message ("unit twelve … respond to"). The default pipeline's
  // `max_turn_silence` already tolerates that; reach for
  // `assemblyAIStt({ maxTurnSilenceMs })` only if your callers pause longer.
  greeting:
    "Dispatch Command Center online. Restoring operational state. I'm ready to take incoming calls, manage active incidents, or run dispatch operations. Say 'dashboard' for a full status report. What do we have.",
  /**
   * A dropped 911 call, written on the incident in hand.
   *
   * The dialog deliberately does NOT move on it — a phone desk carries a
   * hang-up into a final state, but here the caller is one input to a shift:
   * units are rolling and the dispatcher goes on working the board. A hook
   * observes and may not speak; with nothing open there is nothing to write.
   */
  events: {
    "session.timedOut": (event, ctx) => {
      dispatchSlot.update(ctx, (state) => {
        const incident = callInHand(state);
        if (incident === undefined) return;
        logEvent(
          incident,
          "CALLER LOST — line dropped or went silent. Units stay committed; " +
            "attempt callback on the number on file.",
          event.meta.at,
        );
      });
    },
  },
  // The gates decide which tools are LEGAL and `events` observes; this is the
  // one that can stop the desk speaking — never say help is coming before a
  // unit has been assigned. See `guardrails.ts`.
  outputGuardrails: DISPATCH_GUARDRAILS,
  // The system prompt instructs the model to use web_search and run_code, so
  // they must be enabled here — the default builtin set does not include them.
  builtinTools: ["think", "remember", "recall", "calculate", "web_search", "run_code"],
});
