// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { createServer as createViteServer } from "vite";
import type { AgentDef } from "../sdk/types.ts";
import { getApiKey } from "./_discover.ts";

/** Load an AgentDef by dynamically importing agent.ts via Vite SSR. */
export async function loadAgentDef(cwd: string): Promise<AgentDef> {
  const agentPath = path.resolve(cwd, "agent.ts");
  const vite = await createViteServer({
    root: cwd,
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  try {
    const agentModule = await vite.ssrLoadModule(agentPath);
    const agentDef = agentModule.default;

    if (!agentDef || typeof agentDef !== "object" || !agentDef.name) {
      throw new Error("agent.ts must export a default agent definition (from defineAgent())");
    }
    return agentDef as AgentDef;
  } finally {
    await vite.close();
  }
}

/** Build an env record from process.env, ensuring ASSEMBLYAI_API_KEY is set. */
export async function resolveServerEnv(): Promise<Record<string, string>> {
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
  );
  if (!env.ASSEMBLYAI_API_KEY) {
    env.ASSEMBLYAI_API_KEY = await getApiKey();
  }
  return env;
}

/** Load the ws package from the user's project and build a createWebSocket factory. */
async function loadWsFromProject(cwd: string) {
  const wsPath = path.resolve(cwd, "node_modules", "ws", "index.js");
  const mod = await import(wsPath);
  const WS = mod.default ?? mod;
  return (url: string, opts: { headers: Record<string, string> }) =>
    new WS(url, { headers: opts.headers });
}

/** Create and start an agent server with static file serving. */
export async function bootServer(
  agentDef: AgentDef,
  clientDir: string,
  env: Record<string, string>,
  port: number,
  cwd: string,
): Promise<void> {
  const createWebSocket = await loadWsFromProject(cwd);
  const clientHtml = await fs.readFile(path.join(clientDir, "index.html"), "utf-8");

  const { createServer } = await import("aai/server");
  const server = createServer({
    agent: agentDef,
    clientHtml,
    clientDir,
    env,
    createWebSocket,
  });
  await server.listen(port);
}
