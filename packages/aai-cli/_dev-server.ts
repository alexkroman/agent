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
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { type AgentDef, errorMessage } from "@alexkroman1/aai";
import type { AgentServer } from "@alexkroman1/aai/runtime";
import pDebounce from "p-debounce";
import { ensureApiKey } from "./_config.ts";
import { fallbackHtmlPlugin } from "./_default-html.ts";
import { resolveServerEnv } from "./_server-common.ts";
import { log } from "./_ui.ts";
import { validateAgentExport } from "./_utils.ts";

// ─── Env loading ────────────────────────────────────────────────────────────

async function resolveAgentEnv(root: string): Promise<Record<string, string>> {
  const env = await resolveServerEnv(root);
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
  validateAgentExport(agentDef);
  return agentDef;
}

// ─── File watching ──────────────────────────────────────────────────────────

/**
 * Watch the agent directory for changes and call `onChange` when detected.
 * Debounces to avoid rapid restarts.
 */
function watchDirectory(dir: string, onChange: (filename: string | null) => void): FSWatcher {
  const DEBOUNCE_MS = 300;

  const debouncedChange = pDebounce((filename: string | null) => {
    log.info("File change detected, restarting...");
    onChange(filename);
  }, DEBOUNCE_MS);

  function handleChange(filename: string | null) {
    if (filename && (filename.startsWith(".aai") || filename.includes("node_modules"))) return;

    void debouncedChange(filename);
  }

  return watch(dir, { persistent: false }, (_event, filename) => handleChange(filename));
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

  const { createRuntime, createServer } = await import("@alexkroman1/aai/runtime");

  const hasClient = existsSync(path.join(cwd, "client.tsx"));
  const backendPort = hasClient ? port + 1 : port;

  // When no custom client.tsx, serve the pre-built default aai-ui client.
  // Resolved once: the path is process-stable and require.resolve hits the disk.
  const defaultClientDir = hasClient ? undefined : resolveDefaultClientDir();

  // Load the agent, resolve its env, and start a fresh backend server.
  async function buildServer(): Promise<AgentServer> {
    const agentDef = await loadAgentDef(cwd);
    const env = await resolveAgentEnv(cwd);
    const runtime = createRuntime({ agent: agentDef, env });
    const server = createServer({
      runtime,
      name: agentDef.name,
      ...(defaultClientDir ? { clientDir: defaultClientDir } : {}),
    });
    await server.listen(backendPort);
    return server;
  }

  let currentServer = await buildServer();

  let viteServer: { close(): Promise<void> } | undefined;
  if (hasClient) {
    const { createServer: createViteServer } = await import("vite");
    const target = `http://localhost:${backendPort}`;
    viteServer = await createViteServer({
      root: cwd,
      plugins: [fallbackHtmlPlugin(cwd)],
      server: {
        port,
        proxy: {
          "/health": target,
          "/websocket": { target, ws: true },
        },
      },
    });
    await (viteServer as unknown as { listen(): Promise<void> }).listen();
  }

  let restarting = false;
  const watcher = watchDirectory(cwd, () => {
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
      currentServer = await buildServer();
      log.success("Restarted");
    } catch (err) {
      log.error(`Restart failed: ${errorMessage(err)}`);
    }
  }

  return async () => {
    watcher.close();
    if (viteServer) await viteServer.close();
    await currentServer.close();
  };
}

// When no custom client.tsx, serve the pre-built default aai-ui client.
function resolveDefaultClientDir(): string {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("@alexkroman1/aai-ui/package.json");
  return path.join(path.dirname(pkgPath), "dist", "default-client");
}
