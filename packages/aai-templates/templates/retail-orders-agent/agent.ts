import { agent } from "@alexkroman1/aai";
import { callFlow, record, retailSlot, summarize } from "./store.ts";

export default agent({
  name: "Retail Support",
  listing: "Looks up orders, returns and store credit for an authenticated retail caller",
  /**
   * A per-session ceiling on what the model may spend.
   *
   * This is the template where a budget earns its place: authentication, an
   * order lookup and a staged change are three tool chains deep, the store's
   * projection is large, and a caller who keeps re-asking can run a session
   * for as long as they like. `maxSteps` bounds a REPLY and says nothing about
   * a call. Tokens rather than money, since a price is per-model (see
   * `UsageLimits`); a real call reached 252,825 against an earlier 200_000 and
   * ended mid-support, so this is a ceiling with headroom — read
   * `usage.updated` on a few real conversations and pick yours from that.
   */
  usageLimits: { totalTokens: 2_000_000 },
  // Declaring the flow is what lets the CALL move it, not just a tool:
  // `@session.timedOut` carries a hung-up call into `abandoned`, and
  // `awaitingConfirmation`'s instruction reaches the turn that reads a staged
  // change back.
  dialogs: [callFlow],
  // Callers read order numbers and ten-digit item numbers in bursts with pauses
  // inside one utterance ("W seven six seven … eight oh seven two"). The default
  // pipeline's `max_turn_silence` already tolerates that; reach for
  // `assemblyAIStt({ maxTurnSilenceMs })` only if your callers pause longer.
  greeting:
    "Thanks for calling. Before I can look anything up I'll need to find your account — " +
    "what's the email address on it?",
  /**
   * The activity feed, written by what the session OBSERVES rather than by the
   * tools. `tool.called` fires for every call the model makes — including the
   * ones the gate refuses, which are the most interesting lines the sidebar
   * shows — and `tool.completed` fills in what each one answered. A hook writes
   * state and cannot speak; nothing here changes what the agent says.
   */
  events: {
    "tool.called": (event, ctx) =>
      retailSlot.update(ctx, (state) => {
        record(state, event.toolName, event.meta.at, event.toolCallId);
      }),
    "tool.completed": (event, ctx) =>
      retailSlot.update(ctx, (state) => {
        const line = state.activity.find((entry) => entry.callId === event.toolCallId);
        if (line) line.summary = summarize(event.result);
      }),
  },
});
