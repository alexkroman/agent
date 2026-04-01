// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import type { AgentDef, BuiltinTool, ToolChoice, ToolDef } from "@alexkroman1/aai/types";
import { DEFAULT_GREETING, DEFAULT_SYSTEM_PROMPT } from "@alexkroman1/aai/types";
import { parse as parseToml } from "smol-toml";
import { getApiKey } from "./discover.ts";

/**
 * Parse a `.env` file into a key→value record.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key) entries[key] = line.slice(eq + 1);
  }
  return entries;
}

// ── Parsed TOML config (typed) ─────────────────────────────────────────────

/** The typed result of parsing agent.toml. */
interface ParsedTomlConfig {
  name: string;
  systemPrompt?: string;
  greeting?: string;
  sttPrompt?: string;
  maxSteps?: number;
  toolChoice?: ToolChoice;
  builtinTools?: readonly BuiltinTool[];
  idleTimeoutMs?: number;
}

const TOML_KEY_MAP: Record<string, keyof ParsedTomlConfig> = {
  name: "name",
  system_prompt: "systemPrompt",
  greeting: "greeting",
  stt_prompt: "sttPrompt",
  max_steps: "maxSteps",
  tool_choice: "toolChoice",
  builtin_tools: "builtinTools",
  idle_timeout_ms: "idleTimeoutMs",
};

function parseTomlConfig(raw: Record<string, unknown>): ParsedTomlConfig {
  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const mapped = TOML_KEY_MAP[key];
    if (!mapped) throw new Error(`Unknown key in agent.toml: "${key}"`);
    config[mapped] = value;
  }

  const name = config.name;
  if (!name || typeof name !== "string") {
    throw new Error("agent.toml must have a `name` field.");
  }

  const result: ParsedTomlConfig = { name };
  if (typeof config.systemPrompt === "string") result.systemPrompt = config.systemPrompt;
  if (typeof config.greeting === "string") result.greeting = config.greeting;
  if (typeof config.sttPrompt === "string") result.sttPrompt = config.sttPrompt;
  if (typeof config.maxSteps === "number") result.maxSteps = config.maxSteps;
  if (config.toolChoice != null) result.toolChoice = config.toolChoice as ToolChoice;
  if (Array.isArray(config.builtinTools))
    result.builtinTools = config.builtinTools as BuiltinTool[];
  if (typeof config.idleTimeoutMs === "number") result.idleTimeoutMs = config.idleTimeoutMs;
  return result;
}

/**
 * Load an agent from `agent.toml` + optional `tools.ts`.
 *
 * Reads the TOML config, optionally imports the tools module, merges them,
 * and applies defaults to produce an internal AgentDef.
 */
export async function loadAgent(cwd: string): Promise<AgentDef> {
  const tomlPath = path.resolve(cwd, "agent.toml");
  let tomlContent: string;
  try {
    tomlContent = await fs.readFile(tomlPath, "utf-8");
  } catch (err) {
    throw new Error(`agent.toml not found in ${cwd}. Run \`aai init\` to create one.`, {
      cause: err,
    });
  }

  const config = parseTomlConfig(parseToml(tomlContent));

  // Optionally load tools.ts
  let tools: Readonly<Record<string, ToolDef>> = {};
  let state: (() => Record<string, unknown>) | undefined;
  const toolsPath = path.resolve(cwd, "tools.ts");
  try {
    await fs.access(toolsPath);
    const mod = await import(toolsPath);
    const exported = mod.default ?? {};
    if (exported.tools) tools = exported.tools;
    if (typeof exported.state === "function") state = exported.state;
  } catch {
    // No tools.ts — agent has no custom tools
  }

  const agentDef: AgentDef = {
    name: config.name,
    systemPrompt: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    greeting: config.greeting ?? DEFAULT_GREETING,
    maxSteps: config.maxSteps ?? 5,
    tools,
  };
  if (config.sttPrompt) agentDef.sttPrompt = config.sttPrompt;
  if (config.toolChoice) agentDef.toolChoice = config.toolChoice;
  if (config.builtinTools) agentDef.builtinTools = config.builtinTools;
  if (config.idleTimeoutMs !== undefined) agentDef.idleTimeoutMs = config.idleTimeoutMs;
  if (state) agentDef.state = state;
  return agentDef;
}

/**
 * Build the `ctx.env` record that agent tools will see at runtime.
 *
 * Only variables explicitly declared in `.env` (plus `ASSEMBLYAI_API_KEY`)
 * are included — matching the platform sandbox behavior.
 */
export async function resolveServerEnv(
  cwd?: string,
  baseEnv?: Record<string, string | undefined>,
): Promise<Record<string, string>> {
  let fileEntries: Record<string, string> = {};
  if (cwd) {
    try {
      const content = await fs.readFile(path.join(cwd, ".env"), "utf-8");
      fileEntries = parseEnvFile(content);
    } catch {
      // No .env file — that's fine
    }
  }

  const source = baseEnv ?? process.env;

  const env: Record<string, string> = {};
  for (const [key, fileVal] of Object.entries(fileEntries)) {
    const val = source[key] ?? fileVal;
    if (val !== undefined) env[key] = val;
  }

  if (!env.ASSEMBLYAI_API_KEY) {
    const key = source.ASSEMBLYAI_API_KEY ?? (await getApiKey());
    env.ASSEMBLYAI_API_KEY = key;
  }
  return env;
}
