import { agent } from "@alexkroman1/aai";
import { assemblyAITts } from "@alexkroman1/aai/tts";
import { remind, research } from "./shared.ts";

// An Alexa-style home assistant: short spoken answers, plus the two jobs a smart speaker
// does AFTER the conversation is over — a reminder that goes off at five, and a research
// job that takes minutes. Both are durable runs that find the speaker again by its
// `?client=` id and SAY their result on it (ctx.sayOnClient → the client's inbox socket).
//
// The speaker is the page client.tsx serves: one tap to talk, a ring that shows what the
// agent is doing, and the inbox held open so a reminder plays with no session open. A
// hardware device is the same thing — it connects with its own `?client=` and holds
// `WS /inbox?client=` open itself.
//
// Set TIME_ZONE (an IANA name, e.g. "America/Chicago") once deployed: "remind me at five"
// means five on the HOME's clock, and a deployed agent's machine is not in the home.
export default agent({
  name: "Home Assistant",
  // One line for whoever is reading a LIST of agents — `aai list`, a registry
  // page, the studio's picker. Never the model: what the model is told is
  // `system-prompt.md`, beside this file.
  description: "Alexa-style home assistant: weather, quick answers, reminders and deep research",
  // The first thing a caller hears. Without one the agent waits for them to speak.
  greeting: "Hi, what can I do for you?",
  // Only the speaking stage is declared; speech-to-text and the LLM are the defaults.
  tts: assemblyAITts({ voice: "jane" }),
  // Setting this REPLACES the default (`["think"]`), so `think` is listed to keep it. All
  // keyless but text_me, which reads TEXTBELT_KEY and SMS_TO_PHONE and texts only the
  // owner: without them it says it can't, and nothing else here depends on it.
  builtinTools: ["think", "open_meteo", "web_search", "calculate", "visit_webpage", "text_me"],
  // Reminders (tools/remind_me.ts): a run per reminder that sleeps until it is due and
  // says it on the speaker. Under `aai dev` without a DATABASE_URL a pending reminder lives
  // only as long as the dev server; deployed, the platform keeps it.
  // Deep research (tools/deep_research.ts): minutes of searching and reading, so a run
  // that says a summary on the speaker when it is done, and texts the report if asked.
  workflows: { remind, research },
});
