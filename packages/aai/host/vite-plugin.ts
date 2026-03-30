// Copyright 2025 the AAI authors. MIT license.
/**
 * Vite plugin for AAI agent development.
 *
 * In dev mode: boots the agent backend server and configures proxy.
 * Handles .env loading, runtime creation, and WebSocket proxying
 * so `vite` alone gives you a working dev server.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { Plugin, ViteDevServer } from "vite";

export type AaiPluginOptions = {
  /** Path to agent entry (default: "agent.ts") */
  agent?: string;
  /** Backend port (default: Vite port + 1) */
  backendPort?: number;
};

function parseEnvFile(content: string): Record<string, string> {
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

async function resolveAgentEnv(root: string): Promise<Record<string, string>> {
  let fileEntries: Record<string, string> = {};
  try {
    const content = await fs.readFile(path.join(root, ".env"), "utf-8");
    fileEntries = parseEnvFile(content);
  } catch {
    // No .env — fine
  }

  const env: Record<string, string> = {};
  for (const [key, fileVal] of Object.entries(fileEntries)) {
    env[key] = process.env[key] ?? fileVal;
  }
  if (!env.ASSEMBLYAI_API_KEY && process.env.ASSEMBLYAI_API_KEY) {
    env.ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;
  }
  return env;
}

export function aai(options?: AaiPluginOptions): Plugin {
  const agentEntry = options?.agent ?? "agent.ts";
  let backendPort = options?.backendPort;
  let server: { close(): Promise<void> } | null = null;

  return {
    name: "aai",
    apply: "serve",

    config(config) {
      // Determine backend port from option, env, or vite port + 1
      const vitePort = config.server?.port ?? 3000;
      const envPort = Number(process.env.AAI_BACKEND_PORT);
      backendPort = backendPort ?? (envPort > 0 ? envPort : vitePort + 1);

      // Inject proxy config for the backend
      const target = `http://localhost:${backendPort}`;
      return {
        server: {
          proxy: {
            "/health": target,
            "/websocket": { target, ws: true },
          },
        },
      };
    },

    async configureServer(viteServer: ViteDevServer) {
      const root = viteServer.config.root;
      const agentPath = path.resolve(root, agentEntry);

      // Dynamically import the agent and boot the backend
      const { createRuntime, createServer } = await import("./server.ts");
      const agentModule = await viteServer.ssrLoadModule(agentPath);
      const agentDef = agentModule.default;

      if (!agentDef?.name) {
        viteServer.config.logger.error("agent.ts must export a default defineAgent() call");
        return;
      }

      const env = await resolveAgentEnv(root);
      const runtime = createRuntime({ agent: agentDef, env });
      const agentServer = createServer({ runtime, name: agentDef.name });
      if (backendPort == null) throw new Error("backendPort was not resolved during config phase");
      await agentServer.listen(backendPort);
      server = agentServer;

      viteServer.config.logger.info(`Agent backend on port ${backendPort}`);
    },

    async buildEnd() {
      if (server) {
        await server.close();
        server = null;
      }
    },
  };
}
