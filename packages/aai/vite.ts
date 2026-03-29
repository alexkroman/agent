// Copyright 2025 the AAI authors. MIT license.
/**
 * Vite plugin for aai voice agents.
 *
 * Provides a single `aai()` plugin that handles:
 * - Dev mode: loads agent.ts, boots the runtime via `createAgentApp()`,
 *   serves all routes as Vite middleware (single process, no proxy)
 * - Build mode: runs the worker lib build alongside the standard client build
 * - Env handling: parses .env with declared-keys-only isolation
 *
 * @example
 * ```ts
 * // vite.config.ts
 * import aai from "@alexkroman1/aai/vite";
 * import { defineConfig } from "vite";
 *
 * export default defineConfig({
 *   plugins: [aai()],
 * });
 * ```
 *
 * @module
 */

import fs from "node:fs/promises";
import path from "node:path";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";
import type { Plugin, ViteDevServer } from "vite";
import { build } from "vite";

/** Options for the aai Vite plugin. */
export type AaiPluginOptions = {
  /**
   * Path to the agent entry file. Defaults to `"agent.ts"` relative to
   * the Vite root.
   */
  agentEntry?: string;
};

/**
 * Parse a `.env` file into a key-value record.
 *
 * Only variables explicitly declared here are forwarded to the agent
 * runtime, matching the platform sandbox behavior.
 */
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

/**
 * Resolve the agent environment — only declared `.env` keys are included.
 * Shell exports override `.env` defaults.
 */
async function resolveAgentEnv(root: string): Promise<Record<string, string>> {
  let fileEntries: Record<string, string> = {};
  try {
    const content = await fs.readFile(path.join(root, ".env"), "utf-8");
    fileEntries = parseEnvFile(content);
  } catch {
    // No .env file — that's fine
  }

  const env: Record<string, string> = {};
  for (const [key, fileVal] of Object.entries(fileEntries)) {
    const val = process.env[key] ?? fileVal;
    if (val !== undefined) env[key] = val;
  }

  if (!env.ASSEMBLYAI_API_KEY && process.env.ASSEMBLYAI_API_KEY) {
    env.ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;
  }
  return env;
}

/**
 * The core aai Vite plugin that handles dev server middleware and build hooks.
 */
function aaiAgentPlugin(opts?: AaiPluginOptions): Plugin {
  const agentEntry = opts?.agentEntry ?? "agent.ts";
  let root = "";
  let shutdownFn: (() => Promise<void>) | null = null;

  return {
    name: "aai:agent",
    enforce: "post",

    configResolved(config) {
      root = config.root;
    },

    // ── Dev mode: boot agent runtime as Vite middleware ──────────────
    configureServer(server: ViteDevServer) {
      // Return a function so our middleware runs after Vite's internal
      // middleware — Vite handles client files/HMR, we handle /health
      // and /websocket.
      return async () => {
        const agentPath = path.resolve(root, agentEntry);

        // Dynamic import of the agent module (Node >=22.6 handles .ts)
        let agentDef: import("./types.ts").AgentDef;
        try {
          const mod = await import(agentPath);
          agentDef = mod.default;
          if (!agentDef?.name) {
            throw new Error("agent.ts must export a default agent definition (from defineAgent())");
          }
        } catch (err) {
          server.config.logger.error(`[aai] Failed to load agent: ${err}`);
          return;
        }

        const env = await resolveAgentEnv(root);

        // Use the existing createAgentApp for full composability — reuses
        // all routes (/health, /websocket, /kv) and WebSocket handling.
        const { createRuntime, createAgentApp } = await import("./server.ts");
        const runtime = createRuntime({ agent: agentDef, env });
        const { app, injectWebSocket, shutdown } = createAgentApp({
          runtime,
          name: agentDef.name,
        });
        shutdownFn = shutdown;

        // Mount the Hono app as Connect middleware for HTTP routes
        server.middlewares.use((req, res, next) => {
          // Let Vite handle its own paths (HMR, static files, etc.)
          // Only intercept agent API routes
          const url = req.url ?? "";
          if (url.startsWith("/health") || url.startsWith("/websocket") || url.startsWith("/kv")) {
            void Promise.resolve(
              app.fetch(
                new Request(new URL(url, `http://${req.headers.host ?? "localhost"}`), {
                  method: req.method ?? "GET",
                  headers: req.headers as Record<string, string>,
                }),
              ),
            ).then(async (response) => {
              res.statusCode = response.status;
              for (const [key, value] of response.headers) {
                res.setHeader(key, value);
              }
              const body = await response.arrayBuffer();
              res.end(Buffer.from(body));
            });
            return;
          }
          next();
        });

        // Wire WebSocket upgrades into Vite's HTTP server.
        // injectWebSocket attaches the ws upgrade handler from @hono/node-ws.
        if (server.httpServer) {
          // biome-ignore lint/suspicious/noExplicitAny: Vite's httpServer is a standard Node http.Server, compatible with @hono/node-server's serve() return type
          injectWebSocket(server.httpServer as any);
        }

        server.config.logger.info(`[aai] Agent "${agentDef.name}" loaded`);
      };
    },

    // ── Build mode: run the worker lib build alongside client output ─
    async buildStart() {
      // Only run the worker build in the "main" (client) build, not in
      // nested builds we trigger ourselves.
      if (process.env.__AAI_WORKER_BUILD === "1") return;

      const buildDir = path.join(root, ".aai", "build");
      process.env.__AAI_WORKER_BUILD = "1";
      try {
        await build({
          configFile: false,
          root,
          logLevel: "warn",
          build: {
            lib: {
              entry: path.resolve(root, agentEntry),
              formats: ["es"],
              fileName: () => "worker.js",
            },
            outDir: buildDir,
            emptyOutDir: true,
            minify: true,
            target: "es2022",
          },
        });
      } finally {
        delete process.env.__AAI_WORKER_BUILD;
      }
    },

    // Graceful shutdown
    async buildEnd() {
      if (shutdownFn) {
        await shutdownFn();
        shutdownFn = null;
      }
    },
  };
}

/**
 * Create the aai Vite plugin bundle.
 *
 * Returns an array of plugins: Preact, Tailwind CSS, and the aai agent plugin.
 *
 * @example
 * ```ts
 * import aai from "@alexkroman1/aai/vite";
 * import { defineConfig } from "vite";
 *
 * export default defineConfig({
 *   plugins: [aai()],
 * });
 * ```
 */
export default function aai(opts?: AaiPluginOptions): Plugin[] {
  return [preact(), tailwindcss(), aaiAgentPlugin(opts)].flat();
}

export { aai };
