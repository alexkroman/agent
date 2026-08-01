import { agent } from "@alexkroman1/aai";
import { assemblyAI as assemblyAILlm } from "@alexkroman1/aai/llm";
import { assemblyAI } from "@alexkroman1/aai/stt";
import { assemblyAI as assemblyAITts } from "@alexkroman1/aai/tts";
import systemPrompt from "./system-prompt.md?raw";

export default agent({
  name: "Math Buddy",
  stt: assemblyAI({ model: "universal-3-5-pro" }),
  llm: assemblyAILlm({ model: "qwen3-next-80b-a3b" }),
  tts: assemblyAITts({ voice: "vera" }),
  systemPrompt,
  greeting:
    "Hey, I'm Math Buddy. Try asking me something like, what's 127 times 849, convert 5 miles to kilometers, or roll 3 twenty-sided dice.",
  builtinTools: ["run_code"],
});
