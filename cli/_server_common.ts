// Copyright 2025 the AAI authors. MIT license.

import path from "node:path";
import { getApiKey } from "./_discover.ts";
import { error as logError, step } from "./_output.ts";

/** Load an AgentDef by dynamically importing agent.ts from the given directory. */
export async function loadAgentDef(cwd: string): Promise<{ name: string }> {
  const agentPath = path.resolve(cwd, "agent.ts");
  const agentModule = await import(agentPath);
  const agentDef = agentModule.default;

  if (!agentDef || typeof agentDef !== "object" || !agentDef.name) {
    throw new Error("agent.ts must export a default agent definition (from defineAgent())");
  }
  return agentDef;
}

/** Build an env record from process.env, ensuring ASSEMBLYAI_API_KEY is set. */
export async function resolveServerEnv(): Promise<Record<string, string>> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (!env.ASSEMBLYAI_API_KEY) {
    try {
      env.ASSEMBLYAI_API_KEY = await getApiKey();
    } catch {
      logError("ASSEMBLYAI_API_KEY not set. Set it in your environment or run `aai env add`.");
      throw new Error("ASSEMBLYAI_API_KEY is required");
    }
  }
  return env;
}

/** Create and start an agent server. */
export async function bootServer(
  agentDef: { name: string },
  html: string,
  env: Record<string, string>,
  port: number,
): Promise<void> {
  step("Start", `http://localhost:${port}`);
  const { createServer } = await import("aai/server");
  const server = createServer({
    agent: agentDef,
    clientHtml: html,
    env,
  });
  await server.listen(port);
  step("Ready", `http://localhost:${port}`);
}
