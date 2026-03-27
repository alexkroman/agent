// Copyright 2025 the AAI authors. MIT license.

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, stepCountIs } from "ai";
import { getApiKey } from "./_discover.ts";
import { makeTools } from "./_generate-tools.ts";
import { runCommand, step } from "./_ui.ts";

const SYSTEM_PROMPT = `You are a pragmatic, expert coding agent that builds voice agents using the AAI framework. You persist until the task is fully handled — do not stop at analysis or partial fixes.

# Workflow

1. Use glob or ls to see the project structure.
2. Use read on CLAUDE.md — this is the complete API reference. Read it carefully before writing any code.
3. Use read on agent.ts to see the current code.
4. Plan your approach: what name, instructions, greeting, tools, state, and builtinTools does this agent need?
5. Use write to update agent.ts with the complete implementation. Write the entire file — no placeholders or TODOs.
6. Use read to verify your changes. If something is wrong, use edit to fix it.

# Rules

- CLAUDE.md contains the full API reference — always read it first.
- agent.ts must export a default defineAgent() call.
- Only modify agent.ts (and optionally client.tsx for custom UI).
- Do NOT create extra files or install packages.
- Write production-quality code. Tools should have clear descriptions and .describe() on each Zod parameter.
- Handle edge cases in tool execute functions.
- Parallelize tool calls when possible — e.g. read multiple files at once.`;

export async function runGenerateCommand(opts: { cwd: string; prompt: string }): Promise<void> {
  const { cwd, prompt } = opts;
  const baseURL = process.env.LLM_BASE_URL ?? "https://llm-gateway.assemblyai.com/v1";
  const modelId = process.env.LLM_MODEL ?? "gpt-5.2";

  await runCommand(async ({ log }) => {
    const apiKey = await getApiKey();

    log(step("Generate", "Generating agent code..."));

    const provider = createOpenAICompatible({ name: "assemblyai", baseURL, apiKey });

    const result = await generateText({
      model: provider(modelId),
      system: SYSTEM_PROMPT,
      prompt,
      tools: makeTools(cwd),
      maxOutputTokens: 16_384,
      toolChoice: "auto",
      stopWhen: stepCountIs(20),
      onStepFinish: ({ toolCalls, toolResults, finishReason, text }) => {
        for (let i = 0; i < toolCalls.length; i++) {
          const tc = toolCalls[i];
          const tr = toolResults[i];
          const name = tc?.toolName ?? "?";
          const file = tc?.args?.filePath ?? "";
          const resStr = tr?.result != null ? String(tr.result).slice(0, 80) : "(no result)";
          log(step("Generate", `${name} ${file} → ${resStr}`));
        }
        if (finishReason === "stop" && text) {
          log(step("Generate", text.slice(0, 120)));
        }
      },
    });

    log(
      step("Generate", `Done (${result.steps.length} step(s), ${result.usage.totalTokens} tokens)`),
    );
  });
}
