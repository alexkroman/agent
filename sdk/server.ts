// Copyright 2025 the AAI authors. MIT license.
/**
 * Self-hostable agent server.
 *
 * `createServer()` returns a server with a standard `fetch(Request): Response`
 * handler and a Node.js `listen()` method for HTTP + WebSocket.
 *
 * @module
 */

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { Kv } from "./kv.ts";
import type { Logger, S2SConfig } from "./runtime.ts";
import { consoleLogger, DEFAULT_S2S_CONFIG } from "./runtime.ts";
import { type CreateS2sWebSocket, wrapOnStyleWebSocket } from "./s2s.ts";
import type { AgentDef } from "./types.ts";
import { createWintercServer, type WintercServer } from "./winterc_server.ts";
import type { SessionWebSocket } from "./ws_handler.ts";

export type ServerOptions = {
  /** The agent definition returned by `defineAgent()`. */
  agent: AgentDef;
  /** Environment variables. Defaults to `process.env`. */
  env?: Record<string, string>;
  /** KV store. Defaults to in-memory. */
  kv?: Kv;
  /** HTML to serve at `GET /`. */
  clientHtml?: string;
  /** Directory containing built client files (index.html + assets/). */
  clientDir?: string;
  /** Logger. Defaults to console. */
  logger?: Logger;
  /** S2S configuration. Defaults to AssemblyAI production. */
  s2sConfig?: S2SConfig;
  /** WebSocket factory for S2S connections. Auto-detected if not provided. */
  createWebSocket?: CreateS2sWebSocket;
};

export type AgentServer = {
  /** Standard fetch handler using web `Request`/`Response` types. */
  fetch(request: Request): Promise<Response>;
  /** Start listening on the given port. */
  listen(port?: number): Promise<void>;
  /** Stop the server. */
  close(): Promise<void>;
};

/** Try to load the `ws` package for WebSocket connections. */
async function loadWsFactory(): Promise<CreateS2sWebSocket> {
  try {
    const mod = await import("ws");
    const WS = mod.default ?? mod;
    return (url: string, opts: { headers: Record<string, string> }) =>
      wrapOnStyleWebSocket(new WS(url, { headers: opts.headers }));
  } catch {
    throw new Error(
      "WebSocket factory not provided and `ws` package not found. " +
        "Install `ws` (`npm install ws`) or pass `createWebSocket` option.",
    );
  }
}

/** Filter env to only defined string values. */
function resolveEnv(env: Record<string, string | undefined>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) resolved[key] = value;
  }
  return resolved;
}

/**
 * Create a self-hostable agent server.
 *
 * @example
 * ```ts
 * import { defineAgent } from "aai";
 * import { createServer } from "aai/server";
 *
 * const agent = defineAgent({ name: "my-agent" });
 * const server = createServer({ agent });
 * await server.listen(3000);
 * ```
 */
export function createServer(options: ServerOptions): AgentServer {
  const {
    agent,
    kv,
    clientHtml,
    clientDir,
    logger = consoleLogger,
    s2sConfig = DEFAULT_S2S_CONFIG,
  } = options;

  const env = resolveEnv(
    options.env ?? (typeof process !== "undefined" ? (process.env as Record<string, string>) : {}),
  );

  let wsFactory: CreateS2sWebSocket | null = options.createWebSocket ?? null;

  async function getWsFactory(): Promise<CreateS2sWebSocket> {
    if (!wsFactory) {
      wsFactory = await loadWsFactory();
    }
    return wsFactory;
  }

  // WintercServer is created lazily after wsFactory is resolved
  let winterc: WintercServer | null = null;

  function getWinterc(): WintercServer {
    if (!winterc) {
      winterc = createWintercServer({
        agent,
        env,
        ...(kv ? { kv } : {}),
        createWebSocket:
          wsFactory ??
          (() => {
            throw new Error("WebSocket factory not loaded");
          }),
        ...(clientHtml !== undefined ? { clientHtml } : {}),
        logger,
        s2sConfig,
      });
    }
    return winterc;
  }

  let serverHandle: { shutdown(): Promise<void> } | null = null;

  return {
    fetch(request: Request) {
      return getWinterc().fetch(request);
    },

    async listen(port = 3000) {
      await getWsFactory();
      const wintercServer = getWinterc();

      const app = new Hono();

      if (clientDir) {
        app.use("/*", serveStatic({ root: clientDir }));
      }

      // Delegate all remaining requests to the winterc server
      app.all("/*", (c) => wintercServer.fetch(c.req.raw));

      const nodeServer = serve({ fetch: app.fetch, port });

      // Wait for server to be ready
      await new Promise<void>((resolve) => {
        nodeServer.on("listening", resolve);
      });

      // Attach WebSocket upgrade
      try {
        const wsMod = await import("ws");
        const wss = new wsMod.WebSocketServer({ noServer: true });
        nodeServer.on("upgrade", (req, socket, head) => {
          wss.handleUpgrade(req, socket, head, (ws) => {
            const reqUrl = new URL(req.url ?? "/", `http://localhost:${port}`);
            wintercServer.handleWebSocket(ws as unknown as SessionWebSocket, {
              skipGreeting: reqUrl.searchParams.has("resume"),
            });
          });
        });
      } catch {
        logger.warn("ws package not available for Node.js WebSocket upgrade");
      }

      serverHandle = {
        async shutdown() {
          await new Promise<void>((resolve, reject) => {
            nodeServer.close((err) => (err ? reject(err) : resolve()));
          });
        },
      };
    },

    async close() {
      await winterc?.close();
      await serverHandle?.shutdown();
    },
  };
}
