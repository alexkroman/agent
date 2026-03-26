// Copyright 2025 the AAI authors. MIT license.

import path from "node:path";
import type { AgentServer } from "@alexkroman1/aai/server";
import type { AgentDef } from "@alexkroman1/aai/types";
import { getApiKey } from "./_discover.ts";

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
 * When {@link cwd} is provided, `.env` is loaded into `process.env` via
 * Node's built-in `process.loadEnvFile()`. Existing env vars are never
 * overridden, so shell exports always win — matching `--env-file` semantics.
 *
 * @param cwd - Project directory to load `.env` from (optional).
 * @param baseEnv - Override the base environment (defaults to process.env).
 */
export async function resolveServerEnv(
  cwd?: string,
  baseEnv?: Record<string, string | undefined>,
): Promise<Record<string, string>> {
  if (cwd) {
    try {
      process.loadEnvFile(path.join(cwd, ".env"));
    } catch {
      // No .env file — that's fine
    }
  }
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(baseEnv ?? process.env).filter((e): e is [string, string] => e[1] !== undefined),
  );
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
