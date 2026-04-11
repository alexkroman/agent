// Copyright 2025 the AAI authors. MIT license.
/**
 * Dev server for directory-based agents.
 *
 * Imports agent.ts directly for the full agent definition,
 * builds a runtime, and starts an HTTP+WebSocket server. Watches for
 * file changes and restarts automatically. Optionally runs Vite for
 * client SPA HMR.
 */

import { existsSync, type FSWatcher, watch } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { type AgentDef, errorMessage } from "aai";
import type { AgentServer } from "aai/runtime";
import pDebounce from "p-debounce";
import { ensureApiKey } from "./_config.ts";
import { resolveServerEnv } from "./_server-common.ts";
import { log } from "./_ui.ts";

// ─── Env loading ────────────────────────────────────────────────────────────

async function resolveAgentEnv(root: string): Promise<Record<string, string>> {
  const env = await resolveServerEnv(root);
  // Inject global API key if not already set by .env or process.env
  if (!env.ASSEMBLYAI_API_KEY) {
    env.ASSEMBLYAI_API_KEY = await ensureApiKey();
  }
  return env;
}

// ─── Agent loading ──────────────────────────────────────────────────────────

/**
 * Load agent definition from agent.ts directly.
 * Uses cache-busting query param for hot reload support.
 */
// biome-ignore lint/suspicious/noExplicitAny: agent state type varies per agent
async function loadAgentDef(cwd: string): Promise<AgentDef<any>> {
  const agentPath = path.join(cwd, "agent.ts");
  const agentUrl = `${pathToFileURL(agentPath).href}?t=${Date.now()}`;
  const mod = await import(agentUrl);
  const agentDef = mod.default;
  if (!agentDef?.name || typeof agentDef.name !== "string") {
    throw new Error("agent.ts must export default agent({ name: ... })");
  }
  return agentDef;
}

// ─── File watching ──────────────────────────────────────────────────────────

/**
 * Watch the agent directory for changes and call `onChange` when detected.
 * Debounces to avoid rapid restarts.
 */
function watchDirectory(dir: string, onChange: (filename: string | null) => void): FSWatcher[] {
  const watchers: FSWatcher[] = [];
  const DEBOUNCE_MS = 300;

  const debouncedChange = pDebounce((filename: string | null) => {
    log.info("File change detected, restarting...");
    onChange(filename);
  }, DEBOUNCE_MS);

  function handleChange(filename: string | null) {
    // Ignore .aai build artifacts and node_modules
    if (filename && (filename.startsWith(".aai") || filename.includes("node_modules"))) return;

    void debouncedChange(filename);
  }

  // Watch root for agent.ts, .env changes
  watchers.push(watch(dir, { persistent: false }, (_event, filename) => handleChange(filename)));

  return watchers;
}

// ─── Dev server ─────────────────────────────────────────────────────────────

export type DevServerOptions = {
  cwd: string;
  port: number;
};

/**
 * Start the dev server for a directory-based agent.
 *
 * Returns a cleanup function to shut down the server and watchers.
 */
export async function startDevServer(opts: DevServerOptions): Promise<() => Promise<void>> {
  const { cwd, port } = opts;

  const { createRuntime, createServer } = await import("aai/runtime");

  // Check if client.tsx exists for Vite HMR
  const hasClient = existsSync(path.join(cwd, "client.tsx"));

  // Determine ports: if we have a client, Vite gets the main port and
  // the backend gets port+1. Otherwise backend gets the main port.
  const backendPort = hasClient ? port + 1 : port;
  const vitePort = port;

  // Load agent from agent.ts
  const agentDef = await loadAgentDef(cwd);
  const env = await resolveAgentEnv(cwd);
  const runtime = createRuntime({ agent: agentDef, env });
  const agentServer = createServer({ runtime, name: agentDef.name });
  await agentServer.listen(backendPort);

  // Start Vite for client HMR if client.tsx exists
  let viteServer: { close(): Promise<void> } | undefined;
  if (hasClient) {
    const { createServer: createViteServer } = await import("vite");
    const target = `http://localhost:${backendPort}`;
    viteServer = await createViteServer({
      root: cwd,
      server: {
        port: vitePort,
        proxy: {
          "/health": target,
          "/websocket": { target, ws: true },
        },
      },
    });
    await (viteServer as unknown as { listen(): Promise<void> }).listen();
  }

  // Set up file watching for auto-restart
  let restarting = false;
  let currentServer: AgentServer = agentServer;
  let currentVite = viteServer;
  let currentEnv = env;
  const watchers = watchDirectory(cwd, () => {
    if (restarting) return;
    restarting = true;
    void restart().finally(() => {
      restarting = false;
    });
  });

  async function restart(): Promise<void> {
    try {
      await currentServer.close();
    } catch {
      /* ignore */
    }
    try {
      const newAgentDef = await loadAgentDef(cwd);
      currentEnv = await resolveAgentEnv(cwd);
      const newRuntime = createRuntime({ agent: newAgentDef, env: currentEnv });
      const newServer = createServer({ runtime: newRuntime, name: newAgentDef.name });
      await newServer.listen(backendPort);
      currentServer = newServer;
      log.success("Restarted");
    } catch (err) {
      log.error(`Restart failed: ${errorMessage(err)}`);
    }
  }

  // Return cleanup function
  return async () => {
    for (const w of watchers) w.close();
    if (currentVite) {
      await currentVite.close();
      currentVite = undefined;
    }
    await currentServer.close();
  };
}
