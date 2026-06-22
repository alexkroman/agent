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
import { AGENT_CSP, MAX_WS_PAYLOAD_BYTES } from "../sdk/constants.ts";
import type { Kv } from "../sdk/kv.ts";
import { VectorRequestSchema } from "../sdk/protocol.ts";
import { errorMessage } from "../sdk/utils.ts";
import type { Vector, VectorQueryOptions } from "../sdk/vector.ts";
import { parseWsUpgradeParams } from "../sdk/ws-upgrade.ts";
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
  vector?: Vector;
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

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

async function serveStatic(
  dir: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const url = req.url?.split("?")[0] ?? "/";
  const filePath = path.join(dir, url === "/" ? "index.html" : url);

  // Use resolved dir + separator to avoid prefix collisions
  // (e.g. dir="/app/static" matching "/app/static-secrets/…").
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

async function readBody(req: http.IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

async function handleVectorPost(
  vector: Vector,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const parsed = VectorRequestSchema.safeParse(JSON.parse(await readBody(req)));
    if (!parsed.success) {
      sendJson(res, 400, { error: parsed.error.message });
      return;
    }
    const op = parsed.data;
    let result: unknown;
    switch (op.op) {
      case "upsert":
        await vector.upsert(op.id, op.text, op.metadata);
        result = "OK";
        break;
      case "query": {
        const opts: VectorQueryOptions = {};
        if (op.topK !== undefined) opts.topK = op.topK;
        if (op.filter !== undefined) opts.filter = op.filter;
        result = await vector.query(op.text, opts);
        break;
      }
      case "delete":
        await vector.delete(op.ids);
        result = "OK";
        break;
      default: {
        const _exhaustive: never = op;
        return _exhaustive;
      }
    }
    sendJson(res, 200, { result });
  } catch (err) {
    sendJson(res, 500, { error: errorMessage(err) });
  }
}

async function handleKvGet(
  kv: Kv,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const key = new URL(req.url ?? "/", "http://localhost").searchParams.get("key");
  if (!key) {
    sendJson(res, 400, { error: "Missing key query parameter" });
    return;
  }
  try {
    const value = await kv.get(key);
    if (value === null) {
      res.writeHead(404, JSON_HEADERS);
      res.end("null");
      return;
    }
    sendJson(res, 200, value);
  } catch {
    sendJson(res, 500, { error: "KV error" });
  }
}

/**
 * Create an HTTP + WebSocket server for an agent.
 *
 * @internal Used by aai-cli dev server.
 */
export function createServer(options: ServerOptions): AgentServer {
  const { runtime, clientHtml, clientDir, logger = consoleLogger, kv, vector } = options;
  const name = options.name ?? "agent";

  if (clientHtml && clientDir) {
    throw new Error("clientHtml and clientDir are mutually exclusive");
  }

  const defaultHtml =
    clientHtml ??
    `<!DOCTYPE html><html><body><h1>${escapeHtml(name)}</h1><p>Agent server running.</p></body></html>`;

  async function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: string,
    method: string,
  ): Promise<void> {
    if (clientDir && (await serveStatic(clientDir, req, res))) return;

    if (method === "GET" && url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(defaultHtml);
      return;
    }

    logger.error(`${method} ${url} 404`);
    sendJson(res, 404, { error: "Not found" });
  }

  const httpServer = http.createServer((req, res) => {
    const url = req.url?.split("?")[0] ?? "/";
    const method = req.method ?? "GET";

    res.setHeader("Content-Security-Policy", AGENT_CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");

    if (method === "GET" && url === "/health") {
      sendJson(res, 200, { status: "ok", name });
      return;
    }
    if (kv && method === "GET" && url === "/kv") {
      void handleKvGet(kv, req, res);
      return;
    }
    if (vector && method === "POST" && url === "/vector") {
      void handleVectorPost(vector, req, res);
      return;
    }

    void handleRequest(req, res, url, method);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });

  httpServer.on("upgrade", (req, socket, head) => {
    const url = req.url?.split("?")[0] ?? "";
    if (!url.startsWith("/websocket")) return;

    wss.handleUpgrade(req, socket, head, (ws) => {
      const startOpts = parseWsUpgradeParams(req.url ?? "");

      logger.info(`WS upgrade ${url}${startOpts.skipGreeting ? " (resume)" : ""}`);

      runtime.startSession(ws as unknown as SessionWebSocket, startOpts);
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
