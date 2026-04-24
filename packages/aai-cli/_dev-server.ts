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

/**
 * Extract pluggable providers from an agent definition into the partial
 * options shape consumed by `createRuntime`. Keeps callers free of the
 * five-way spread that otherwise pushes them past Biome's complexity gate.
 */
// biome-ignore lint/suspicious/noExplicitAny: provider options bag
function providerOpts(agentDef: AgentDef<any>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (agentDef.stt) out.stt = agentDef.stt;
  if (agentDef.llm) out.llm = agentDef.llm;
  if (agentDef.tts) out.tts = agentDef.tts;
  if (agentDef.kv) out.kv = agentDef.kv;
  if (agentDef.vector) out.vector = agentDef.vector;
  return out;
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
    if (filename && (filename.startsWith(".aai") || filename.includes("node_modules"))) return;

    void debouncedChange(filename);
  }

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

  const { createRuntime, createServer } = await import("@alexkroman1/aai/runtime");

  const hasClient = existsSync(path.join(cwd, "client.tsx"));
  const backendPort = hasClient ? port + 1 : port;
  const vitePort = port;

  const agentDef = await loadAgentDef(cwd);
  const env = await resolveAgentEnv(cwd);
  const runtime = createRuntime({ agent: agentDef, env, ...providerOpts(agentDef) });

  // When no custom client.tsx, serve the pre-built default aai-ui client
  function resolveDefaultClientDir(): string {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("@alexkroman1/aai-ui/package.json");
    return path.join(path.dirname(pkgPath), "dist", "default-client");
  }
  const agentServer = createServer({
    runtime,
    name: agentDef.name,
    ...(hasClient ? {} : { clientDir: resolveDefaultClientDir() }),
  });
  await agentServer.listen(backendPort);

  let viteServer: { close(): Promise<void> } | undefined;
  if (hasClient) {
    const { createServer: createViteServer } = await import("vite");
    const target = `http://localhost:${backendPort}`;
    viteServer = await createViteServer({
      root: cwd,
      plugins: [fallbackHtmlPlugin(cwd)],
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
      const newRuntime = createRuntime({
        agent: newAgentDef,
        env: currentEnv,
        ...providerOpts(newAgentDef),
      });
      const newServer = createServer({
        runtime: newRuntime,
        name: newAgentDef.name,
        ...(hasClient ? {} : { clientDir: resolveDefaultClientDir() }),
      });
      await newServer.listen(backendPort);
      currentServer = newServer;
      log.success("Restarted");
    } catch (err) {
      log.error(`Restart failed: ${errorMessage(err)}`);
    }
  }

  return async () => {
    for (const w of watchers) w.close();
    if (currentVite) {
      await currentVite.close();
      currentVite = undefined;
    }
    await currentServer.close();
  };
}
