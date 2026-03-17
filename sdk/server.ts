// Copyright 2025 the AAI authors. MIT license.
/**
 * Self-hostable agent server.
 *
 * `createServer()` returns a server with a standard `fetch(Request): Response`
 * handler and a Node.js `listen()` method for HTTP + WebSocket.
 *
 * @module
 */

import type { Kv } from "./kv.ts";
import type { Logger, S2SConfig } from "./runtime.ts";
import { consoleLogger, DEFAULT_S2S_CONFIG } from "./runtime.ts";
import type { CreateS2sWebSocket, S2sWebSocket } from "./s2s.ts";
import type { AgentDef } from "./types.ts";
import { createWintercServer, type WintercServer } from "./winterc_server.ts";

export type ServerOptions = {
  /** The agent definition returned by `defineAgent()`. */
  agent: AgentDef;
  /** Environment variables. Defaults to `process.env`. */
  env?: Record<string, string>;
  /** KV store. Defaults to in-memory. */
  kv?: Kv;
  /** HTML to serve at `GET /`. */
  clientHtml?: string;
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
      new WS(url, { headers: opts.headers }) as unknown as S2sWebSocket;
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
  const { agent, kv, clientHtml, logger = consoleLogger, s2sConfig = DEFAULT_S2S_CONFIG } = options;

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
        createWebSocket: wsFactory!,
        clientHtml,
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
      // Ensure WS factory is loaded before starting
      await getWsFactory();

      const http = await import("node:http");

      const nodeServer = http.createServer(async (req, res) => {
        try {
          const protocol = (req.socket as { encrypted?: boolean }).encrypted ? "https" : "http";
          const host = req.headers.host ?? `localhost:${port}`;
          const url = new URL(req.url ?? "/", `${protocol}://${host}`);
          const headers = new Headers();
          for (const [key, val] of Object.entries(req.headers)) {
            if (val) headers.set(key, Array.isArray(val) ? val[0]! : val);
          }
          const request = new Request(url, {
            method: req.method ?? "GET",
            headers,
          });
          const response = await getWinterc().fetch(request);
          res.writeHead(response.status, Object.fromEntries(response.headers));
          const body = await response.text();
          res.end(body);
        } catch (err: unknown) {
          res.writeHead(500);
          res.end(err instanceof Error ? err.message : "Internal Server Error");
        }
      });

      // WebSocket upgrade via ws package
      try {
        const wsMod = await import("ws");
        const WSServer = wsMod.WebSocketServer ?? wsMod.default?.Server;
        if (WSServer) {
          const wss = new WSServer({ noServer: true });
          nodeServer.on("upgrade", (req: unknown, socket: unknown, head: unknown) => {
            wss.handleUpgrade(
              req as Parameters<typeof wss.handleUpgrade>[0],
              socket as Parameters<typeof wss.handleUpgrade>[1],
              head as Parameters<typeof wss.handleUpgrade>[2],
              (ws: WebSocket) => {
                const reqUrl = new URL(
                  (req as { url?: string }).url ?? "/",
                  `http://localhost:${port}`,
                );
                const resume = reqUrl.searchParams.has("resume");
                getWinterc().handleWebSocket(ws, { skipGreeting: resume });
              },
            );
          });
        }
      } catch {
        logger.warn("ws package not available for Node.js WebSocket upgrade");
      }

      await new Promise<void>((resolve) => {
        nodeServer.listen(port, () => {
          logger.info(`Agent "${agent.name}" listening on http://localhost:${port}`);
          resolve();
        });
      });

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
