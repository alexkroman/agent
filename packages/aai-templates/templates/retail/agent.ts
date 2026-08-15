import { agent } from "@alexkroman1/aai";
import { storeView } from "./shared.ts";
import { retailSlot } from "./store.ts";

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
});
