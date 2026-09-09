import { agent } from "@alexkroman1/aai";

// The whole agent. Three files make it up and none of them imports another:
// this one, `system-prompt.md` beside it, and `tools/get_weather.ts` — each
// found by WHERE IT SITS. That is the idea the rest of the framework is built
// on, so it is worth seeing here before anywhere else.
//
// No providers declared: the agent runs the default all-AssemblyAI cascaded
// pipeline, billed to ASSEMBLYAI_API_KEY. Declare any of stt/llm/tts to swap a
// single stage.
export default agent({
  name: "Quickstart Assistant",
  // One line for whoever is reading a LIST of agents — `aai list`, a registry
  // page, the studio's picker. Never the model: what the model is told is
  // `system-prompt.md`, beside this file.
  description: "Looks up the current weather for any city",
  // The first thing a caller hears. Without one the agent waits for them to
  // speak, which on a phone call reads as a dead line.
  greeting: "Hi — I can look up the weather anywhere. Which city?",
  // Any name from `ASSEMBLYAI_TTS_VOICES`. It is sugar for a `tts` descriptor,
  // so declaring `tts: assemblyAITts({ voice })` yourself is the same thing
  // spelled out — and either one replaces only the speaking stage.
  voice: "jane",
});
