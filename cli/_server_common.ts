// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { tsImport } from "tsx/esm/api";
import type { AgentDef } from "../sdk/types.ts";
import { getApiKey } from "./_discover.ts";

/** Load an AgentDef by dynamically importing agent.ts via tsx. */
export async function loadAgentDef(cwd: string): Promise<AgentDef> {
  const agentPath = path.resolve(cwd, "agent.ts");
  const agentModule = await tsImport(agentPath, cwd);
  const agentDef = agentModule.default;

  if (!agentDef || typeof agentDef !== "object" || !agentDef.name) {
    throw new Error("agent.ts must export a default agent definition (from defineAgent())");
  }
  return agentDef as AgentDef;
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

/** Create and start an agent server with static file serving. */
export async function bootServer(
  agentDef: AgentDef,
  clientDir: string,
  env: Record<string, string>,
  port: number,
): Promise<void> {
  const { wrapOnStyleWebSocket } = await import("../sdk/capnweb.ts");
  const wsMod = await import("ws");
  const WS = wsMod.default ?? wsMod;
  const createWebSocket = (url: string, opts: { headers: Record<string, string> }) =>
    wrapOnStyleWebSocket(new WS(url, { headers: opts.headers }));
  const clientHtml = await fs.readFile(path.join(clientDir, "index.html"), "utf-8");

  const { createServer } = await import("../sdk/server.ts");
  const server = createServer({
    agent: agentDef,
    clientHtml,
    clientDir,
    env,
    createWebSocket,
  });
  await server.listen(port);
}
