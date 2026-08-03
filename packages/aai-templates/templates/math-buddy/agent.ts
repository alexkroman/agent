import { agent, assemblyAIPipeline } from "@alexkroman1/aai";
import { assemblyAILlm } from "@alexkroman1/aai/llm";
import systemPrompt from "./system-prompt.md?raw";

export default agent({
  name: "Math Buddy",
  ...assemblyAIPipeline(),
  // Overriding the LLM stage: this tutor delegates every calculation to
  // run_code, so it needs turn-taking speed more than reasoning depth —
  // and Flash-Lite is both quicker and cheaper than the preset's default.
  llm: assemblyAILlm({ model: "gemini-2.5-flash-lite" }),
  systemPrompt,
  greeting:
    "Hey, I'm Math Buddy. Try asking me something like, what's 127 times 849, convert 5 miles to kilometers, or roll 3 twenty-sided dice.",
  builtinTools: ["run_code"],
});
