// Copyright 2025 the AAI authors. MIT license.

import path from "node:path";
import type { AgentServer } from "@alexkroman1/aai/server";
import type { AgentDef } from "@alexkroman1/aai/types";
import { getApiKey } from "./_discover.ts";

/**
 * Parse a `.env` file into a key-value record.
 *
 * Supports `KEY=VALUE`, optional quoting (single/double), `#` comments,
 * and blank lines. Does **not** support multi-line values or variable
 * interpolation — use explicit values.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();
    // Strip matching quotes
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (key) env[key] = value;
  }
  return env;
}

/**
 * Load a `.env` file from the given directory. Returns an empty record if the
 * file does not exist.
 */
export async function loadEnvFile(dir: string): Promise<Record<string, string>> {
  try {
    const content = await fs.readFile(path.join(dir, ".env"), "utf-8");
    return parseEnvFile(content);
  } catch {
    return {};
  }
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
 * Build an env record, ensuring ASSEMBLYAI_API_KEY is set.
 *
 * When {@link cwd} is provided, a `.env` file in that directory is loaded
 * first. Process environment variables take precedence over `.env` values,
 * so you can always override a `.env` entry by exporting a shell variable.
 *
 * @param cwd - Project directory to load `.env` from (optional).
 * @param baseEnv - Override the base environment (defaults to process.env).
 */
export async function resolveServerEnv(
  cwd?: string,
  baseEnv?: Record<string, string | undefined>,
): Promise<Record<string, string>> {
  const dotEnv = cwd ? await loadEnvFile(cwd) : {};
  const processEnv: Record<string, string> = Object.fromEntries(
    Object.entries(baseEnv ?? process.env).filter((e): e is [string, string] => e[1] !== undefined),
  );
  // .env values are the base; process env wins on conflicts
  const env: Record<string, string> = { ...dotEnv, ...processEnv };
  if (!env.ASSEMBLYAI_API_KEY) {
    env.ASSEMBLYAI_API_KEY = await getApiKey();
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
