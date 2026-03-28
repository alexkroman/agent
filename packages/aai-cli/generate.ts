// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, stepCountIs } from "ai";
import { consola as _consola } from "consola";
import { getApiKey } from "./_discover.ts";
import { makeTools } from "./_generate-tools.ts";

const consola = _consola.create({ defaults: { message: "" }, formatOptions: { date: false } });

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
2. Use read on agent.ts to see the current code.
3. Plan your approach: what name, instructions, greeting, tools, state, and builtinTools does this agent need?
4. Use write to update agent.ts with the complete implementation. Write the entire file — no placeholders or TODOs.
5. Use read to verify your changes. If something is wrong, use edit to fix it.

# Rules

- The API reference is included below — do NOT read CLAUDE.md, it is already in your context.
- agent.ts must export a default defineAgent() call.
- Only modify agent.ts (and optionally client.tsx for custom UI).
- Do NOT create extra files or install packages.
- Write production-quality code. Tools should have clear descriptions and .describe() on each Zod parameter.
- Handle edge cases in tool execute functions.
- Parallelize tool calls when possible — e.g. read multiple files at once.`;

function toolLabel(name: string, input: Record<string, unknown>): string {
  const icon = TOOL_ICONS[name] ?? "•";
  const file = (input.filePath ?? input.path ?? input.pattern ?? "") as string;
  if (name === "bash") return `${icon} ${name} ${String(input.command ?? "").slice(0, 60)}`;
  if (file) return `${icon} ${name} ${file}`;
  return `${icon} ${name}`;
}

function formatDuration(ms: number): string {
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function printCode(filePath: string, content: string): void {
  const lines = content.split("\n");
  const maxLines = 40;
  const truncated = lines.length > maxLines;
  const shown = truncated ? lines.slice(0, maxLines).join("\n") : content;
  const suffix = truncated ? `\n... (${lines.length - maxLines} more lines)` : "";
  consola.box({ title: filePath, message: shown + suffix, style: { borderColor: "dim" } });
}

function maybeShowCode(toolName: string, input: Record<string, unknown> | undefined): void {
  if ((toolName === "write" || toolName === "edit") && input) {
    const filePath = String(input.filePath ?? "");
    const content = String(input.content ?? input.newString ?? "");
    if (filePath && content) printCode(filePath, content);
  }
}

export async function runGenerateCommand(opts: { cwd: string; prompt: string }): Promise<void> {
  const { cwd, prompt } = opts;
  const baseURL = process.env.LLM_BASE_URL ?? "https://llm-gateway.assemblyai.com/v1";
  const modelId = process.env.LLM_MODEL ?? "gpt-5.2";

  const apiKey = await getApiKey();

  // Inject CLAUDE.md into the system prompt so the model doesn't waste a step reading it.
  let systemPrompt = SYSTEM_PROMPT;
  try {
    const claudeMd = await fs.readFile(path.join(cwd, "CLAUDE.md"), "utf-8");
    systemPrompt += `\n\n# API Reference (CLAUDE.md)\n\n${claudeMd}`;
  } catch {
    // No CLAUDE.md — the model can still use tools to discover the API.
  }

  consola.start("Planning...");

  try {
    const provider = createOpenAICompatible({ name: "assemblyai", baseURL, apiKey });

    const result = await generateText({
      model: provider(modelId),
      system: systemPrompt,
      prompt,
      tools: makeTools(cwd),
      maxOutputTokens: 65_536,
      toolChoice: "auto",
      stopWhen: stepCountIs(20),
      experimental_onStepStart: ({ stepNumber }) => {
        consola.start(`Step ${stepNumber + 1} · Thinking...`);
      },
      experimental_onToolCallStart: ({ toolCall }) => {
        const input = toolCall.input as Record<string, unknown> | undefined;
        consola.info(toolLabel(toolCall.toolName, input ?? {}));
      },
      experimental_onToolCallFinish: ({ toolCall, durationMs, ...rest }) => {
        const input = toolCall.input as Record<string, unknown> | undefined;
        const label = toolLabel(toolCall.toolName, input ?? {});
        const time = formatDuration(durationMs);
        const ok = "success" in rest && rest.success;

        if (ok) {
          consola.success(`${label} ${time}`);
          maybeShowCode(toolCall.toolName, input);
        } else {
          consola.fail(`${label} ${time}`);
        }
      },
      onStepFinish: ({ finishReason, text }) => {
        if (finishReason === "stop" && text) {
          consola.box(text);
        }
      },
    });

    consola.success(`Done (${result.steps.length} steps, ${result.usage.totalTokens} tokens)`);
  } catch (err) {
    consola.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
