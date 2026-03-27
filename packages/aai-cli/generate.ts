// Copyright 2025 the AAI authors. MIT license.

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, stepCountIs } from "ai";
import pc from "picocolors";
import yoctoSpinner from "yocto-spinner";
import { getApiKey } from "./_discover.ts";
import { makeTools } from "./_generate-tools.ts";

const TOOL_ICONS: Record<string, string> = {
  read: "→",
  edit: "✎",
  write: "✏",
  glob: "✱",
  grep: "◇",
  bash: "$",
  ls: "▪",
};

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

function toolLabel(name: string, input: Record<string, unknown>): string {
  const icon = TOOL_ICONS[name] ?? "•";
  const file = (input.filePath ?? input.path ?? input.pattern ?? "") as string;
  if (name === "bash")
    return `${pc.dim(icon)} ${pc.cyan(name)} ${pc.dim(String(input.command ?? "").slice(0, 60))}`;
  if (file) return `${pc.dim(icon)} ${pc.cyan(name)} ${file}`;
  return `${pc.dim(icon)} ${pc.cyan(name)}`;
}

export async function runGenerateCommand(opts: { cwd: string; prompt: string }): Promise<void> {
  const { cwd, prompt } = opts;
  const baseURL = process.env.LLM_BASE_URL ?? "https://llm-gateway.assemblyai.com/v1";
  const modelId = process.env.LLM_MODEL ?? "gpt-5.2";

  const apiKey = await getApiKey();
  let spinner = yoctoSpinner({ text: "Thinking..." }).start();

  try {
    const provider = createOpenAICompatible({ name: "assemblyai", baseURL, apiKey });

    const result = await generateText({
      model: provider(modelId),
      system: SYSTEM_PROMPT,
      prompt,
      tools: makeTools(cwd),
      maxOutputTokens: 65_536,
      toolChoice: "auto",
      stopWhen: stepCountIs(20),
      onStepFinish: ({ staticToolCalls, finishReason, text }) => {
        for (const tc of staticToolCalls) {
          const label = toolLabel(tc.toolName, tc.input as Record<string, unknown>);
          spinner.stop(`${label}`);
          spinner = yoctoSpinner({ text: "Thinking..." }).start();
        }
        if (finishReason === "stop" && text) {
          spinner.stop(pc.dim(text.slice(0, 120)));
          spinner = yoctoSpinner({ text: "Thinking..." }).start();
        }
      },
    });

    spinner.stop(
      `${pc.green("✔")} Done ${pc.dim(`(${result.steps.length} steps, ${result.usage.totalTokens} tokens)`)}`,
    );
  } catch (err) {
    spinner.stop(`${pc.red("✖")} ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
