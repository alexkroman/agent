// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import type { AgentServer } from "@alexkroman1/aai/server";
import type { AgentDef } from "@alexkroman1/aai/types";
import { getApiKey } from "./_discover.ts";

/**
 * Return the variable names declared in a `.env` file.
 *
 * Only used to determine *which* keys the developer intended as agent
 * secrets — actual values are resolved from `process.env` (so shell
 * overrides still win).
 */
export function envFileKeys(content: string): string[] {
  const keys: string[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key) keys.push(key);
  }
  return keys;
}

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
  if (typeof agentDef.instructions !== "string") missing.push("instructions (string)");
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
 * Only variables explicitly declared in `.env` (plus `ASSEMBLYAI_API_KEY`)
 * are included — matching the platform sandbox behavior where `ctx.env`
 * contains only secrets set via `aai secret put`. This prevents agents
 * from accidentally depending on shell-level vars (PATH, HOME, etc.) that
 * won't exist in production.
 *
 * Values are resolved from `process.env` after loading `.env` via Node's
 * built-in `process.loadEnvFile()`, so shell exports override `.env`.
 *
 * @param cwd - Project directory containing `.env` (optional).
 * @param baseEnv - Override the environment to read values from (tests only).
 */
export async function resolveServerEnv(
  cwd?: string,
  baseEnv?: Record<string, string | undefined>,
): Promise<Record<string, string>> {
  let declaredKeys: string[] = [];
  if (cwd) {
    const envPath = path.join(cwd, ".env");
    try {
      // Parse key names from the .env file
      const content = await fs.readFile(envPath, "utf-8");
      declaredKeys = envFileKeys(content);
      // Load values into process.env (existing vars are not overridden)
      process.loadEnvFile(envPath);
    } catch {
      // No .env file — that's fine
    }
  }

  const source = baseEnv ?? process.env;

  // Only include explicitly-declared keys (not all of process.env)
  const env: Record<string, string> = {};
  for (const key of declaredKeys) {
    const val = source[key];
    if (val !== undefined) env[key] = val;
  }

  if (!env.ASSEMBLYAI_API_KEY) {
    const key = source.ASSEMBLYAI_API_KEY ?? (await getApiKey());
    env.ASSEMBLYAI_API_KEY = key;
  }
  return env;
}

/**
 * Create and start an agent server with static file serving.
 *
 * NOTE: This dynamically imports `@alexkroman1/aai/server` which has peer
 * dependencies on `hono` and `@hono/node-server`. Those packages are listed
 * as direct dependencies of aai-cli (in package.json) solely to satisfy
 * those peer deps — they are not imported directly by aai-cli code.
 */
export async function bootServer(
  agentDef: AgentDef,
  clientDir: string,
  env: Record<string, string>,
  port: number,
): Promise<AgentServer> {
  const { createServer } = await import("@alexkroman1/aai/server");
  const server = createServer({ agent: agentDef, clientDir, env });
  await server.listen(port);
  return server;
}

/**
 * Boot the agent server without client serving.
 *
 * Used in dev mode where Vite handles client files with HMR,
 * and only the backend (health, WebSocket) runs on this server.
 */
export async function bootBackendServer(
  agentDef: AgentDef,
  env: Record<string, string>,
  port: number,
): Promise<AgentServer> {
  const { createServer } = await import("@alexkroman1/aai/server");
  const server = createServer({ agent: agentDef, env });
  await server.listen(port);
  return server;
}
