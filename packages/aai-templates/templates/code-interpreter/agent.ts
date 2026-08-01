import { agent } from "@alexkroman1/aai";
import { assemblyAI as assemblyAILlm } from "@alexkroman1/aai/llm";
import { assemblyAI } from "@alexkroman1/aai/stt";
import { assemblyAI as assemblyAITts } from "@alexkroman1/aai/tts";
import systemPrompt from "./system-prompt.md?raw";

export default agent({
  name: "Coda",
  stt: assemblyAI({ model: "universal-3-5-pro" }),
  llm: assemblyAILlm({ model: "qwen3-next-80b-a3b" }),
  tts: assemblyAITts({ voice: "vera" }),
  systemPrompt,
  greeting:
    "Hey, I'm Coda. I solve problems by writing and running code. Try asking me something like, what's the 50th fibonacci number, or what day of the week was January 1st 2000.",
  builtinTools: ["run_code"],
});
