import { openai } from "@ai-sdk/openai";
import { agent } from "@alexkroman1/aai";
import { assemblyAI } from "@alexkroman1/aai/stt";
import { cartesia } from "@alexkroman1/aai/tts";

// Pipeline mode: pair a real-time STT (AssemblyAI Universal-3 Pro RT), a
// language model routed through the Vercel AI SDK (OpenAI gpt-4o-mini),
// and a streaming TTS (Cartesia). When `stt`, `llm`, and `tts` are all
// set, the runtime switches from the default S2S path to the
// pipeline orchestrator.
const base = agent({
  name: "pipeline-simple",
  systemPrompt: "You are a helpful voice assistant. Reply in short sentences.",
  greeting: "Hi! I'm running in pipeline mode. What can I help with?",
});

export default {
  ...base,
  stt: assemblyAI({ model: "u3pro-rt" }),
  llm: openai("gpt-4o-mini"),
  tts: cartesia({ voice: "694f9389-aac1-45b6-b726-9d9369183238" }),
};
