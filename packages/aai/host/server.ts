// Copyright 2025 the AAI authors. MIT license.
/**
 * Self-hostable agent server.
 *
 * {@link createServer} wraps a {@link Runtime} with an HTTP + WebSocket
 * server using only `node:http` and `ws` (no framework dependencies).
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer } from "ws";
import { AGENT_CSP, MAX_WS_PAYLOAD_BYTES } from "../isolate/constants.ts";
import type { Kv } from "../isolate/kv.ts";
import type { Runtime } from "./direct-executor.ts";
import type { Logger } from "./runtime.ts";
import { consoleLogger } from "./runtime.ts";
import type { SessionWebSocket } from "./ws-handler.ts";

export { createRuntime, type Runtime, type RuntimeOptions } from "./direct-executor.ts";

/**
 * Configuration for {@link createServer}.
 * @public
 */
export type ServerOptions = {
  runtime: Runtime;
  name?: string;
  kv?: Kv;
  clientHtml?: string;
  clientDir?: string;
  logger?: Logger;
};

/**
 * Handle returned by {@link createServer}.
 * @public
 */
export type AgentServer = {
  listen(port?: number): Promise<void>;
  close(): Promise<void>;
  port: number | undefined;
};

// ── Static file serving ─────────────────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json",
};

function serveStatic(dir: string, req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const url = req.url?.split("?")[0] ?? "/";
  const filePath = path.join(dir, url === "/" ? "index.html" : url);

  // Prevent path traversal
  if (!filePath.startsWith(dir)) return false;

  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_TYPES[ext] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime, "Content-Length": stat.size });
    fs.createReadStream(filePath).pipe(res);
    return true;
  } catch {
    return false;
  }
}

// ── Server ──────────────────────────────────────────────────────────────

/**
 * Create an HTTP + WebSocket server for self-hosted agent deployments.
 *
 * @example
 * ```ts
 * import { defineAgent } from "@alexkroman1/aai";
 * import { createRuntime, createServer } from "@alexkroman1/aai/server";
 *
 * const agent = defineAgent({ name: "my-agent" });
 * const runtime = createRuntime({ agent, env: process.env });
 * const server = createServer({ runtime, name: agent.name });
 * await server.listen(3000);
 * ```
 *
 * @public
 */
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

export function createServer(options: ServerOptions): AgentServer {
  const { runtime, clientHtml, clientDir, logger = consoleLogger, kv } = options;
  const name = options.name ?? "agent";

  if (clientHtml && clientDir) {
    throw new Error("clientHtml and clientDir are mutually exclusive");
  }

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

    // Static files from client dir
    if (clientDir && serveStatic(clientDir, req, res)) return;

    // Default HTML
    if (method === "GET" && url === "/") {
      const escaped = name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const body =
        clientHtml ??
        `<!DOCTYPE html><html><body><h1>${escaped}</h1><p>Agent server running.</p></body></html>`;
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(body);
      return;
    }

    // 404
    logger.error(`${method} ${url} 404`);
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  // WebSocket upgrade via ws
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });

  httpServer.on("upgrade", (req, socket, head) => {
    const url = req.url?.split("?")[0] ?? "";
    if (!url.startsWith("/websocket")) return;

    wss.handleUpgrade(req, socket, head, (ws) => {
      const search = req.url?.includes("?") ? (req.url.split("?")[1] ?? "") : "";
      const params = new URLSearchParams(search);
      const resumeFrom = params.get("sessionId") ?? undefined;
      const skipGreeting = params.has("resume") || resumeFrom !== undefined;

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
