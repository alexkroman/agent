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
      // Ensure WS factory is loaded before starting
      await getWsFactory();

      const http = await import("node:http");

      const nodeServer = http.createServer(async (req, res) => {
        // Serve static files from clientDir if available
        if (clientDir && req.url) {
          const served = await serveStaticFile(req.url, clientDir, res);
          if (served) return;
        }
        await nodeHttpHandler(req, res, port, getWinterc);
      });

      attachWsUpgrade(nodeServer, port, getWinterc, logger);

      await new Promise<void>((resolve) => {
        nodeServer.listen(port, () => resolve());
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

// ─── Static file serving ────────────────────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

async function serveStaticFile(
  reqUrl: string,
  clientDir: string,
  res: {
    writeHead(status: number, headers?: Record<string, string>): void;
    end(body?: string | Buffer): void;
  },
): Promise<boolean> {
  const { readFile } = await import("node:fs/promises");
  const { join, extname, normalize } = await import("node:path");

  const urlPath = new URL(reqUrl, "http://localhost").pathname;
  const relPath = urlPath === "/" ? "index.html" : urlPath.slice(1);
  const filePath = normalize(join(clientDir, relPath));

  // Prevent directory traversal
  if (!filePath.startsWith(clientDir)) return false;

  try {
    const content = await readFile(filePath);
    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

// ─── Node.js HTTP/WS helpers ─────────────────────────────────────────────────

async function nodeHttpHandler(
  req: {
    socket: unknown;
    headers: Record<string, string | string[] | undefined>;
    url?: string | undefined;
    method?: string | undefined;
  },
  res: {
    writeHead(status: number, headers?: Record<string, string>): void;
    end(body?: string): void;
  },
  port: number,
  getWinterc: () => WintercServer,
): Promise<void> {
  try {
    const protocol = (req.socket as { encrypted?: boolean }).encrypted ? "https" : "http";
    const host = req.headers.host ?? `localhost:${port}`;
    const url = new URL(req.url ?? "/", `${protocol}://${host}`);
    const headers = new Headers();
    for (const [key, val] of Object.entries(req.headers)) {
      if (val) headers.set(key, Array.isArray(val) ? (val[0] ?? "") : val);
    }
    const request = new Request(url, { method: req.method ?? "GET", headers });
    const response = await getWinterc().fetch(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  } catch (err: unknown) {
    res.writeHead(500);
    res.end(err instanceof Error ? err.message : "Internal Server Error");
  }
}

function attachWsUpgrade(
  nodeServer: { on(event: string, handler: (...args: unknown[]) => void): void },
  port: number,
  getWinterc: () => WintercServer,
  logger: Logger,
): void {
  import("ws")
    .then((wsMod) => {
      const WSServer = wsMod.WebSocketServer;
      if (!WSServer) return;
      const wss = new WSServer({ noServer: true });
      nodeServer.on("upgrade", (req: unknown, socket: unknown, head: unknown) => {
        wss.handleUpgrade(
          req as Parameters<typeof wss.handleUpgrade>[0],
          socket as Parameters<typeof wss.handleUpgrade>[1],
          head as Parameters<typeof wss.handleUpgrade>[2],
          (ws) => {
            const reqUrl = new URL(
              (req as { url?: string }).url ?? "/",
              `http://localhost:${port}`,
            );
            getWinterc().handleWebSocket(ws as unknown as SessionWebSocket, {
              skipGreeting: reqUrl.searchParams.has("resume"),
              uid: reqUrl.searchParams.get("uid") ?? undefined,
            });
          },
        );
      });
    })
    .catch(() => {
      logger.warn("ws package not available for Node.js WebSocket upgrade");
    });
}
