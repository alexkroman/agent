import { anthropic } from "@ai-sdk/anthropic";
import { agent } from "@alexkroman1/aai";
import { assemblyAI } from "@alexkroman1/aai/stt";
import { cartesia } from "@alexkroman1/aai/tts";

// Pipeline mode: pair a real-time STT (AssemblyAI Universal-3 Pro RT), a
// language model routed through the Vercel AI SDK (Claude Haiku), and a
// streaming TTS (Cartesia). When `stt`, `llm`, and `tts` are all set, the
// runtime switches from the default S2S path to the pipeline orchestrator.
export default agent({
  name: "pipeline-simple",
  systemPrompt: "You are a helpful voice assistant. Reply in short sentences.",
  greeting: "Hi! I'm running in pipeline mode. What can I help with?",
  stt: assemblyAI({ model: "u3pro-rt" }),
  llm: anthropic("claude-haiku-4-5"),
  tts: cartesia({ voice: "694f9389-aac1-45b6-b726-9d9369183238" }),
});
