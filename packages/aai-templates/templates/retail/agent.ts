import { agent } from "@alexkroman1/aai";
import { storeView } from "./shared.ts";
import { callFlow, gateFor, record, retailSlot } from "./store.ts";

export default agent({
  name: "Retail Support",

  // No provider spread: pipeline mode is the default, and an unset stage is
  // filled from the all-AssemblyAI pipeline at parse time. Only `stt` is
  // overridden below; `llm` and `tts` take the defaults.

  // The store lives in one `sessionSlot` (`store.ts`), a pristine copy per
  // session — callers must not see each other's cancellations. Nothing declares
  // it here: the slot installs itself on first access, and its `projection`
  // below is what gives a session that has run no tool something to render.

  // One projection pushed after every tool call. It is a projection, not a
  // flag, because the state holds all six seeded customers and only the
  // authenticated one may reach the browser.
  syncState: retailSlot.projection(storeView),

  // Callers read order numbers and ten-digit item numbers in bursts with pauses
  // inside one utterance ("W seven six seven … eight oh seven two"). The default
  // pipeline's `max_turn_silence` already tolerates that; reach for
  // `assemblyAIStt({ maxTurnSilenceMs })` only if your callers pause longer.
  greeting:
    "Thanks for calling. Before I can look anything up I'll need to find your account — " +
    "what's the email address on it?",

  /**
   * The activity feed's blocked lines, which no tool wrapper could write.
   *
   * `retailTool` records a line per call from INSIDE the body, so it sees every
   * call the caller's own logic answered — and none that `callFlow` refused,
   * because a gated refusal short-circuits before the body. The sidebar simply
   * stopped showing the most interesting calls the model makes: the ones it
   * tried too early.
   *
   * `tool.called` is emitted by the runtime for every call the model makes, so a
   * hook is the only place that observation is available at all. It is also the
   * shape of hook this template is here to show: it WRITES the session's state
   * and it cannot speak — nothing here changes what the agent says, or stops the
   * refusal still reaching the model. It does neither.
   *
   * The gate is evaluated a second time rather than reported by the first,
   * because the refusal happens later and inside the body. That is one fact read
   * twice from one source (`gateFor`, which `retailTool` fills), not two copies
   * of it — and the only cost of the two evaluations disagreeing is a duplicate
   * or missing sidebar line, never a wrong store.
   */
  events: {
    "tool.called": (event, ctx) => {
      const when = gateFor(event.toolName);
      // Not a retail tool, or one this call may run: either way the wrapper owns
      // the line, and writing one here would double it.
      if (!when || when.some((state) => callFlow.matches(ctx, state))) return;
      const at = callFlow.position(ctx);
      retailSlot.update(ctx, (state) => {
        record(state, event.toolName, `blocked: call is at ${at.state}`);
      });
    },
  },
});
