// Copyright 2025 the AAI authors. MIT license.
/** Starter files for a fresh studio project. */

const STARTER_AGENT_TS = `import { agent, tool } from "@alexkroman1/aai";
import { assemblyAI } from "@alexkroman1/aai/stt";
import { assemblyAI as assemblyAILlm } from "@alexkroman1/aai/llm";
import { assemblyAI as assemblyAITts } from "@alexkroman1/aai/tts";
import { z } from "zod";

const rollDice = tool({
  description: "Roll one or more six-sided dice and report the results",
  parameters: z.object({
    count: z.number().int().min(1).max(10).describe("How many dice to roll"),
  }),
  execute: ({ count }) => {
    const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * 6));
    return \`Rolled \${rolls.join(", ")} (total \${rolls.reduce((a, b) => a + b, 0)})\`;
  },
});

export default agent({
  name: "My Voice Agent",
  stt: assemblyAI({ model: "universal-3-5-pro" }),
  llm: assemblyAILlm({ model: "qwen3-next-80b-a3b" }),
  tts: assemblyAITts({ voice: "vera" }),
  systemPrompt:
    "You are a friendly voice assistant. Keep replies short and conversational — they are spoken aloud.",
  greeting: "Hi! Ask me anything, or ask me to roll some dice.",
  tools: { roll_dice: rollDice },
});
`;

/** Files a new studio project starts with. */
export function starterFiles(): Record<string, string> {
  return { "agent.ts": STARTER_AGENT_TS };
}
