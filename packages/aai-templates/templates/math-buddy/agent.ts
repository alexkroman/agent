import { agent } from "@alexkroman1/aai";
import { assemblyAILlm } from "@alexkroman1/aai/llm";
import systemPrompt from "./system-prompt.md?raw";

export default agent({
  name: "Math Buddy",
  // Only the LLM stage is declared: this tutor delegates every calculation
  // to run_code, so it needs turn-taking speed more than reasoning depth —
  // and Flash-Lite is both quicker and cheaper than the default model. STT
  // and TTS stay on the AssemblyAI defaults. (The string shorthand
  // `llm: "gemini-2.5-flash-lite"` desugars to this same descriptor.)
  llm: assemblyAILlm({ model: "gemini-2.5-flash-lite" }),
  systemPrompt,
  greeting:
    "Hey, I'm Math Buddy. Try asking me something like, what's 127 times 849, convert 5 miles to kilometers, or roll 3 twenty-sided dice.",
  builtinTools: ["run_code"],
});
