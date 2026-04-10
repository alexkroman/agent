// Copyright 2025 the AAI authors. MIT license.
/**
 * Dev server for directory-based agents.
 *
 * Reads agent.json for config + imports tools.ts for implementations,
 * builds a runtime, and starts an HTTP+WebSocket server. Watches for
 * file changes and restarts automatically. Optionally runs Vite for
 * client SPA HMR.
 */

import { existsSync, type FSWatcher, watch } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { type AgentDef, errorMessage } from "@alexkroman1/aai-core";
import type { AgentServer } from "@alexkroman1/aai-core/runtime";
import { resolveAgentConfig } from "./_agent-config.ts";
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
 * Load agent definition from tools.ts + agent.json.
 * Uses cache-busting query param for hot reload support.
 */
// biome-ignore lint/suspicious/noExplicitAny: agent state type varies per agent
async function loadAgentDef(cwd: string): Promise<AgentDef<any>> {
  const agentConfig = await resolveAgentConfig(cwd);

  // Import tools.ts if it exists (cache-busted for hot reload)
  let tools: Record<string, unknown> = {};
  const toolsPath = path.join(cwd, "tools.ts");
  try {
    await fs.access(toolsPath);
    const toolsUrl = `${pathToFileURL(toolsPath).href}?t=${Date.now()}`;
    const mod = await import(toolsUrl);
    tools = mod.tools ?? {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // No tools.ts — agent has no custom tools
  }

  // agent.json supplies name, systemPrompt, greeting, maxSteps, etc.
  // tools.ts supplies the tool implementations (merged in)
  // biome-ignore lint/suspicious/noExplicitAny: agent state type varies per agent
  return { ...agentConfig, tools } as AgentDef<any>;
}

// ─── File watching ──────────────────────────────────────────────────────────

/**
 * Watch the agent directory for changes and call `onChange` when detected.
 * Debounces to avoid rapid restarts.
 */
function watchDirectory(dir: string, onChange: () => void): FSWatcher[] {
  const watchers: FSWatcher[] = [];
  const DEBOUNCE_MS = 300;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  function handleChange(filename: string | null) {
    // Ignore .aai build artifacts and node_modules
    if (filename && (filename.startsWith(".aai") || filename.includes("node_modules"))) return;

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      log.info("File change detected, restarting...");
      onChange();
    }, DEBOUNCE_MS);
  }

  // Watch root for tools.ts, agent.json, .env changes
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

  const { createRuntime, createServer } = await import("@alexkroman1/aai-core/runtime");

  // Check if client.tsx exists for Vite HMR
  const hasClient = existsSync(path.join(cwd, "client.tsx"));

  // Determine ports: if we have a client, Vite gets the main port and
  // the backend gets port+1. Otherwise backend gets the main port.
  const backendPort = hasClient ? port + 1 : port;
  const vitePort = port;

  // Load agent from tools.ts + agent.json
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
      const newEnv = await resolveAgentEnv(cwd);
      const newRuntime = createRuntime({ agent: newAgentDef, env: newEnv });
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
