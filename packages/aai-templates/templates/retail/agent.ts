import { agent } from "@alexkroman1/aai";
import { storeView } from "./shared.ts";
import { retailSlot } from "./store.ts";

export default agent({
  name: "Retail Support",

  // No provider spread: pipeline mode is the default, and an unset stage is
  // filled from the all-AssemblyAI pipeline at parse time. Only `stt` is
  // overridden below; `llm` and `tts` take the defaults.

  // The store lives in ctx.state, one pristine copy per session — callers must
  // not see each other's cancellations. Declaring `state` (rather than letting
  // the slot install itself on first access) means the session's store exists
  // before the first tool call, so a resumed connection has something to
  // project; the slot owns the shape either way.
  state: retailSlot.state,

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
});
