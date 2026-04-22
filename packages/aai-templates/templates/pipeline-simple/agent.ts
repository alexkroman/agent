import { anthropic } from "@ai-sdk/anthropic";
import { agent } from "@alexkroman1/aai";
import { assemblyAI } from "@alexkroman1/aai/stt";
import { cartesia } from "@alexkroman1/aai/tts";

export default agent({
  name: "pipeline-simple",
  systemPrompt: "You are a helpful voice assistant. Reply in short sentences.",
  greeting: "Hi! I'm running in pipeline mode. What can I help with?",
  stt: assemblyAI({ model: "u3pro-rt" }),
  llm: anthropic("claude-haiku-4-5"),
  tts: cartesia({ voice: "694f9389-aac1-45b6-b726-9d9369183238" }),
});
