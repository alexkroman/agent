import { agent } from "@alexkroman1/aai";
import { assemblyAI as assemblyAILlm } from "@alexkroman1/aai/llm";
import { assemblyAI } from "@alexkroman1/aai/stt";
import { assemblyAI as assemblyAITts } from "@alexkroman1/aai/tts";
import systemPrompt from "./system-prompt.md?raw";

export default agent({
  name: "Penny",
  stt: assemblyAI({ model: "universal-3-5-pro" }),
  llm: assemblyAILlm({ model: "qwen3-next-80b-a3b" }),
  tts: assemblyAITts({ voice: "vera" }),
  systemPrompt,
  greeting:
    "Hey, I'm Penny, your personal finance helper. Try asking me something like, what's 100 dollars in euros, what's the price of bitcoin, or help me split a 120 dollar bill four ways with 20 percent tip.",
  builtinTools: ["run_code", "fetch_json"],
});
