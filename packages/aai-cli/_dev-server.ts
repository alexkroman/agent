// Copyright 2025 the AAI authors. MIT license.
/**
 * Dev server for directory-based agents.
 *
 * Imports agent.ts directly for the full agent definition,
 * builds a runtime, and starts an HTTP+WebSocket server. Watches for
 * file changes and restarts automatically. Optionally runs Vite for
 * client SPA HMR.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { AgentDef } from "@alexkroman1/aai";
import {
  type AgentServer,
  requiredProviderEnvVars,
  withHostCredentialFallback,
} from "@alexkroman1/aai/runtime";
import { type FSWatcher, watch } from "chokidar";
import getPort, { portNumbers } from "get-port";
import pDebounce from "p-debounce";
import type { ViteDevServer } from "vite";
import { buildWorker, evalWorkerBundle } from "./_bundler.ts";
import { ensureApiKey } from "./_config.ts";
import { fallbackHtmlPlugin } from "./_default-html.ts";
import { resolveServerEnv } from "./_server-common.ts";
import { log } from "./_ui.ts";
import { errorMessage } from "./_utils.ts";

// ─── Env loading ────────────────────────────────────────────────────────────

async function resolveAgentEnv(root: string, agentDef: AgentDef): Promise<Record<string, string>> {
  // Self-hosted only: let provider credentials exported in the shell reach the
  // agent without also being written into `.env`. The SDK resolvers read the
  // agent env alone, so this opt-in is where that trust decision is made —
  // the platform never applies it, keeping its own credentials out of reach of
  // tenant-declared providers.
  const env = withHostCredentialFallback(await resolveServerEnv(root));
  // Derived from the provider registries rather than matched against hardcoded
  // kinds, so a new provider needs no change here and nothing is missed. (The
  // previous check looked only at `stt`/`llm` and only for AssemblyAI.)
  const required = requiredProviderEnvVars(agentDef);

  // Only AssemblyAI's key has an interactive setup flow (it doubles as the
  // platform credential), so that one is prompted for.
  if (required.includes("ASSEMBLYAI_API_KEY") && !env.ASSEMBLYAI_API_KEY) {
    env.ASSEMBLYAI_API_KEY = await ensureApiKey();
  }

  // The rest would otherwise surface as an auth failure on the first session.
  const missing = required.filter((name) => !(env[name] || process.env[name]));
  if (missing.length > 0) {
    log.warn(
      `Missing provider credential${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. ` +
        `Set ${missing.length > 1 ? "them" : "it"} in .env or the environment.`,
    );
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
async function loadAgentDef(cwd: string): Promise<AgentDef> {
  const code = await buildWorker(cwd);
  return evalWorkerBundle(code, cwd);
}

// ─── File watching ──────────────────────────────────────────────────────────

/** True for paths inside `.aai/` or `node_modules/` (never restart-worthy). */
export function isIgnoredPath(dir: string, filePath: string): boolean {
  const rel = path.relative(dir, filePath);
  return rel.startsWith(".aai") || rel.split(path.sep).includes("node_modules");
}

/**
 * Watch the agent directory for changes and call `onChange` when detected.
 * Debounces to avoid rapid restarts. Uses chokidar for reliable recursive
 * watching across platforms (raw `fs.watch` misses events on Linux).
 */
function watchDirectory(dir: string, onChange: () => void): FSWatcher {
  const DEBOUNCE_MS = 300;

  const debouncedChange = pDebounce(() => {
    log.info("File change detected, restarting...");
    onChange();
  }, DEBOUNCE_MS);

  const watcher = watch(dir, {
    ignored: (filePath: string) => isIgnoredPath(dir, filePath),
    ignoreInitial: true,
    persistent: false,
  });
  watcher.on("all", () => void debouncedChange());
  return watcher;
}

// ─── Dev server ─────────────────────────────────────────────────────────────

/** Locate the pre-built default aai-ui client (served when no custom client.tsx). */
function resolveDefaultClientDir(): string {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("@alexkroman1/aai-ui/package.json");
  return path.join(path.dirname(pkgPath), "dist", "default-client");
}

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
  // With a client, Vite owns the user-requested port and proxies to the
  // backend. Prefer port+1 for the backend but fall back to any nearby free
  // port instead of failing with EADDRINUSE (the old `port + 1` was blind).
  const backendPort = hasClient ? await getPort({ port: portNumbers(port + 1, port + 100) }) : port;
  const vitePort = port;

  // When no custom client.tsx, serve the pre-built default aai-ui client.
  // Resolved once — the location can't change for the process lifetime.
  const clientDirOpt = hasClient ? {} : { clientDir: resolveDefaultClientDir() };

  /** Full build sequence, shared by initial startup and every restart. */
  async function buildServer(): Promise<AgentServer> {
    const agentDef = await loadAgentDef(cwd);
    const env = await resolveAgentEnv(cwd, agentDef);
    const runtime = createRuntime({ agent: agentDef, env });
    return createServer({
      runtime,
      name: agentDef.name,
      // Makes host mode *available* in the dev server — it stays off unless
      // AAI_ALLOW_HOST is set, since a `?host=1` client supplies its own agent
      // definition and would otherwise be able to spend the operator's
      // provider credentials unauthenticated. Harnesses (e.g. tau2) opt in.
      env,
      // Host sessions inherit this agent's stt/llm/tts pipeline config.
      hostBaseAgent: agentDef,
      ...clientDirOpt,
    });
  }

  const agentServer = await buildServer();
  // Loopback by default (the dev server has no auth). AAI_DEV_HOST is the
  // escape hatch for setups where loopback isn't reachable — e.g. running
  // `aai dev` inside a container and connecting from the host.
  await agentServer.listen(backendPort, process.env.AAI_DEV_HOST);

  let viteServer: ViteDevServer | undefined;
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
    await viteServer.listen();
  }

  let restarting = false;
  let pendingRestart = false;
  let closed = false;
  let currentServer: AgentServer = agentServer;
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
      const newServer = await buildServer();
      // The cleanup fn may have run while we were rebuilding — don't leave a
      // freshly-listening server orphaned (leaked port / hung event loop).
      if (closed) {
        await newServer.close().catch(() => undefined);
        return;
      }
      await newServer.listen(backendPort, process.env.AAI_DEV_HOST);
      currentServer = newServer;
      log.success("Restarted");
    } catch (err) {
      log.error(`Restart failed: ${errorMessage(err)}`);
    }
  }

  return async () => {
    closed = true;
    await watcher.close();
    await viteServer?.close();
    await currentServer.close();
  };
}
