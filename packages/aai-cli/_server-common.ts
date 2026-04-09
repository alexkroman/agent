// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import type { AgentServer } from "@alexkroman1/aai/host";
import type { AgentDef } from "@alexkroman1/aai/types";
import { parseEnvFile } from "@alexkroman1/aai/utils";

export { parseEnvFile } from "@alexkroman1/aai/utils";

/** Load an AgentDef by dynamically importing agent.ts via Node's native TS support. */
export async function loadAgentDef(cwd: string): Promise<AgentDef> {
  const agentPath = path.resolve(cwd, "agent.ts");
  const agentModule = await import(agentPath);
  const agentDef = agentModule.default;

  if (!agentDef || typeof agentDef !== "object" || !agentDef.name) {
    throw new Error("agent.ts must export a default agent definition (from defineAgent())");
  }

  const missing: string[] = [];
  if (typeof agentDef.name !== "string") missing.push("name (string)");
  if (typeof agentDef.systemPrompt !== "string") missing.push("systemPrompt (string)");
  if (typeof agentDef.greeting !== "string") missing.push("greeting (string)");
  if (typeof agentDef.maxSteps !== "number" && typeof agentDef.maxSteps !== "function")
    missing.push("maxSteps (number or function)");
  if (!agentDef.tools || typeof agentDef.tools !== "object" || Array.isArray(agentDef.tools))
    missing.push("tools (object)");

  if (missing.length > 0) {
    throw new Error(
      `Invalid agent definition: missing or invalid fields: ${missing.join(", ")}. ` +
        "Use defineAgent() to create a valid agent definition.",
    );
  }

  return agentDef as AgentDef;
}

/**
 * Build the `ctx.env` record that agent tools will see at runtime.
 *
 * Only variables explicitly declared in `.env` are included — matching
 * the platform sandbox behavior where `ctx.env`
 * contains only secrets set via `aai secret put`. This prevents agents
 * from accidentally depending on shell-level vars (PATH, HOME, etc.) that
 * won't exist in production.
 *
 * Values are resolved by merging the `.env` file with the current
 * environment — existing shell exports take precedence over `.env`
 * defaults, without mutating `process.env`.
 *
 * @param cwd - Project directory containing `.env` (optional).
 * @param baseEnv - Override the environment to read values from (tests only).
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

  // Only include explicitly-declared keys (not all of process.env).
  // Shell env takes precedence over .env file values.
  const env: Record<string, string> = {};
  for (const [key, fileVal] of Object.entries(fileEntries)) {
    const val = source[key] ?? fileVal;
    if (val !== undefined) env[key] = val;
  }

  return env;
}

/** Create and start an agent server, optionally with static file serving. */
export async function bootServer(
  agentDef: AgentDef,
  clientDir: string | undefined,
  env: Record<string, string>,
  port: number,
): Promise<AgentServer> {
  const { createRuntime, createServer } = await import("@alexkroman1/aai/host");
  const runtime = createRuntime({ agent: agentDef, env });
  const server = createServer({
    runtime,
    name: agentDef.name,
    ...(clientDir ? { clientDir } : {}),
  });
  await server.listen(port);
  return server;
}
