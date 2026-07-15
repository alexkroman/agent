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
import { type AgentDef, errorMessage } from "@alexkroman1/aai";
import type { AgentServer } from "@alexkroman1/aai/runtime";
import pDebounce from "p-debounce";
import { buildWorker, evalWorkerBundle } from "./_bundler.ts";
import { ensureApiKey } from "./_config.ts";
import { fallbackHtmlPlugin } from "./_default-html.ts";
import { resolveServerEnv } from "./_server-common.ts";
import { log } from "./_ui.ts";

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
 * Load the agent definition by bundling agent.ts (and all its local imports)
 * into a single ESM file, then importing that. A raw `import(agent.ts?t=...)`
 * only cache-busts agent.ts itself — transitive imports (./tools.ts, etc.)
 * stay in Node's ESM registry, so edits to them are ignored on reload.
 * Bundling picks them up and matches the deploy path exactly.
 */
// biome-ignore lint/suspicious/noExplicitAny: agent state type varies per agent
async function loadAgentDef(cwd: string): Promise<AgentDef<any>> {
  const code = await buildWorker(cwd);
  // biome-ignore lint/suspicious/noExplicitAny: evalWorkerBundle returns AgentDef
  return (await evalWorkerBundle(code, cwd)) as AgentDef<any>;
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
  const vitePort = port;

  const agentDef = await loadAgentDef(cwd);
  const env = await resolveAgentEnv(cwd);
  const runtime = createRuntime({ agent: agentDef, env });

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
  let pendingRestart = false;
  let closed = false;
  let currentServer: AgentServer = agentServer;
  let currentVite = viteServer;
  const watcher = watchDirectory(cwd, () => {
    // A change during an in-flight restart must not be dropped: flag it so
    // restart() loops once more with the newest files. Otherwise the final
    // save is silently ignored (stale server), or — if the in-flight restart
    // failed on a mid-edit syntax error — the server stays down entirely.
    if (restarting) {
      pendingRestart = true;
      return;
    }
    restarting = true;
    void restart().finally(() => {
      restarting = false;
    });
  });

  async function restart(): Promise<void> {
    do {
      pendingRestart = false;
      await restartOnce();
    } while (pendingRestart && !closed);
  }

  async function restartOnce(): Promise<void> {
    try {
      await currentServer.close();
    } catch {
      /* ignore */
    }
    try {
      const newAgentDef = await loadAgentDef(cwd);
      const newEnv = await resolveAgentEnv(cwd);
      const newRuntime = createRuntime({ agent: newAgentDef, env: newEnv });
      const newServer = createServer({
        runtime: newRuntime,
        name: newAgentDef.name,
        ...(hasClient ? {} : { clientDir: resolveDefaultClientDir() }),
      });
      // The cleanup fn may have run while we were rebuilding — don't leave a
      // freshly-listening server orphaned (leaked port / hung event loop).
      if (closed) {
        await newServer.close().catch(() => undefined);
        return;
      }
      await newServer.listen(backendPort);
      currentServer = newServer;
      log.success("Restarted");
    } catch (err) {
      log.error(`Restart failed: ${errorMessage(err)}`);
    }
  }

  return async () => {
    closed = true;
    watcher.close();
    if (currentVite) {
      await currentVite.close();
      currentVite = undefined;
    }
    await currentServer.close();
  };
}
