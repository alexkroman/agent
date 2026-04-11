// Copyright 2025 the AAI authors. MIT license.
/**
 * Agent HTTP+WebSocket server.
 *
 * {@link createServer} wraps a {@link Runtime} with an HTTP + WebSocket
 * server using only `node:http` and `ws` (no framework dependencies).
 *
 * **Internal module** — used by `aai-cli` dev server. Not a public API.
 * Import via `aai/host`.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import escapeHtml from "escape-html";
import { lookup as mimeLookup } from "mime-types";
import { WebSocketServer } from "ws";
import { parseWsUpgradeParams } from "../sdk/_ws-upgrade.ts";
import { AGENT_CSP, MAX_WS_PAYLOAD_BYTES } from "../sdk/constants.ts";
import type { Kv } from "../sdk/kv.ts";
import type { Runtime } from "./runtime.ts";
import type { Logger } from "./runtime-config.ts";
import { consoleLogger } from "./runtime-config.ts";
import type { SessionWebSocket } from "./ws-handler.ts";

export { createRuntime, type Runtime, type RuntimeOptions } from "./runtime.ts";

/**
 * Configuration for {@link createServer}.
 * @internal
 */
type ServerOptions = {
  runtime: Runtime;
  name?: string;
  kv?: Kv;
  clientHtml?: string;
  clientDir?: string;
  logger?: Logger;
};

/**
 * Handle returned by {@link createServer}.
 * @internal
 */
export type AgentServer = {
  listen(port?: number): Promise<void>;
  close(): Promise<void>;
  port: number | undefined;
};

// ── Static file serving ─────────────────────────────────────────────────

async function serveStatic(
  dir: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const url = req.url?.split("?")[0] ?? "/";
  const filePath = path.join(dir, url === "/" ? "index.html" : url);

  // Prevent path traversal — use resolved dir + separator to avoid prefix
  // collisions (e.g. dir="/app/static" matching "/app/static-secrets/…").
  const resolved = path.resolve(dir);
  if (!filePath.startsWith(resolved + path.sep) && filePath !== resolved) return false;

  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return false;
    const ext = path.extname(filePath).toLowerCase();
    const mime = mimeLookup(ext) || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime, "Content-Length": stat.size });
    fs.createReadStream(filePath).pipe(res);
    return true;
  } catch {
    return false;
  }
}

// ── Server ──────────────────────────────────────────────────────────────

function handleKvGet(kv: Kv, req: http.IncomingMessage, res: http.ServerResponse): void {
  const fullUrl = new URL(req.url ?? "/", "http://localhost");
  const key = fullUrl.searchParams.get("key");
  if (!key) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing key query parameter" }));
    return;
  }
  kv.get(key)
    .then((value) => {
      if (value === null) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end("null");
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(value));
      }
    })
    .catch(() => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "KV error" }));
    });
}

/**
 * Create an HTTP + WebSocket server for an agent.
 *
 * @internal Used by aai-cli dev server.
 */
export function createServer(options: ServerOptions): AgentServer {
  const { runtime, clientHtml, clientDir, logger = consoleLogger, kv } = options;
  const name = options.name ?? "agent";

  if (clientHtml && clientDir) {
    throw new Error("clientHtml and clientDir are mutually exclusive");
  }

  // Pre-compute the default HTML page once (the agent name never changes).
  const escapedName = escapeHtml(name);
  const defaultHtml =
    clientHtml ??
    `<!DOCTYPE html><html><body><h1>${escapedName}</h1><p>Agent server running.</p></body></html>`;

  const httpServer = http.createServer((req, res) => {
    const url = req.url?.split("?")[0] ?? "/";
    const method = req.method ?? "GET";

    // Security headers
    res.setHeader("Content-Security-Policy", AGENT_CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");

    // Health endpoint
    if (method === "GET" && url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", name }));
      return;
    }

    // KV endpoint
    if (kv && method === "GET" && url === "/kv") {
      handleKvGet(kv, req, res);
      return;
    }

    // Routes that may need async handling
    void handleRequest(req, res, url, method);
  });

  async function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: string,
    method: string,
  ): Promise<void> {
    // Static files from client dir
    if (clientDir && (await serveStatic(clientDir, req, res))) return;

    // Default HTML
    if (method === "GET" && url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(defaultHtml);
      return;
    }

    // 404
    logger.error(`${method} ${url} 404`);
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  // WebSocket upgrade via ws
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });

  httpServer.on("upgrade", (req, socket, head) => {
    const url = req.url?.split("?")[0] ?? "";
    if (!url.startsWith("/websocket")) return;

    wss.handleUpgrade(req, socket, head, (ws) => {
      const { resumeFrom, skipGreeting } = parseWsUpgradeParams(req.url ?? "");

      logger.info(`WS upgrade ${url}${skipGreeting ? " (resume)" : ""}`);

      runtime.startSession(ws as unknown as SessionWebSocket, {
        skipGreeting,
        ...(resumeFrom ? { resumeFrom } : {}),
      });
    });
  });

  let listenPort: number | undefined;

  return {
    get port() {
      return listenPort;
    },

    async listen(port = 3000) {
      await new Promise<void>((resolve, reject) => {
        httpServer.on("error", reject);
        httpServer.listen(port, () => {
          const addr = httpServer.address();
          listenPort = typeof addr === "object" && addr ? addr.port : port;
          resolve();
        });
      });
    },

    async close() {
      try {
        await runtime.shutdown();
      } finally {
        try {
          wss.close();
        } finally {
          if (listenPort !== undefined) {
            await new Promise<void>((resolve, reject) => {
              httpServer.close((err) => (err ? reject(err) : resolve()));
            });
          }
          listenPort = undefined;
        }
      }
    },
  };
}
