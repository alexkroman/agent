// Copyright 2025 the AAI authors. MIT license.
/**
 * Self-hosted agent HTTP + WebSocket server.
 *
 * {@link createServer} wraps a runtime from `createRuntime` with an
 * HTTP + WebSocket server using only `node:http` and `ws` (no framework
 * dependencies) — the same server `aai dev` runs. Use it to host an agent on
 * your own infrastructure instead of the managed platform: see
 * `examples/self-hosted-server` for a runnable setup.
 *
 * Import via `@alexkroman1/aai/runtime`.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import escapeHtml from "escape-html";
import { lookup as mimeLookup } from "mime-types";
import { WebSocketServer } from "ws";
import { buildClientConfig, CLIENT_CONFIG_PATH } from "../sdk/client-config.ts";
import { AGENT_CSP, MAX_WS_PAYLOAD_BYTES } from "../sdk/constants.ts";
import type { AgentDef } from "../sdk/types.ts";
import { errorMessage } from "../sdk/utils.ts";
import { parseWsUpgradeParams } from "../sdk/ws-upgrade.ts";
import { isHostAllowed, startHostSession } from "./host-mode.ts";
import type { Logger } from "./runtime-config.ts";
import { consoleLogger } from "./runtime-config.ts";
import type { AgentRuntime } from "./runtime-types.ts";
import { type SessionWebSocket, safeSend } from "./ws-handler.ts";

/**
 * The session-facing slice of a runtime — all {@link createServer} needs.
 * A runtime built with `createRuntime` satisfies it directly.
 *
 * Narrowed to these two methods (rather than demanding a full
 * `AgentRuntime`) so an embedder can supply a lazily-built runtime facade.
 */
export type SessionRuntime = Pick<AgentRuntime, "startSession" | "shutdown">;

/** Configuration for {@link createServer}. */
export type ServerOptions = {
  /** The runtime sessions are started on — see `createRuntime`. */
  runtime: SessionRuntime;
  /** Display name served by `GET /client-config`. Defaults to `"agent"`. */
  name?: string;
  /** Directory of static client assets to serve at `/`. */
  clientDir?: string;
  /** Structured logger. Defaults to the console logger. */
  logger?: Logger;
  /**
   * Environment for host-mode connections (a `?host=1` WebSocket whose first
   * `config` frame supplies its own agent) and the source of secrets for the
   * per-connection runtime.
   *
   * Supplying `env` does not by itself enable host mode: it is opt-in via
   * `AAI_ALLOW_HOST` (see `isHostAllowed`). Omitting `env` disables host mode
   * unconditionally — any `?host=1` connection is rejected.
   */
  env?: Record<string, string>;
  /**
   * The deployed agent. Host-mode sessions inherit its `stt`/`llm`/`tts`
   * provider config so they run the operator's configured pipeline instead of
   * the default S2S path. Only prompt/greeting/tools come from the client.
   */
  hostBaseAgent?: AgentDef;
  /** Agent greeting, included in the `GET /client-config` response. */
  greeting?: string;
  /**
   * First look at every WebSocket upgrade. Return true to claim it (the
   * server then leaves the socket alone); return false to fall through to
   * the standard `/websocket` session handling. Lets an embedder (the
   * platform's guest harness) add its own upgrade surface — its host
   * control channel — without a second HTTP server.
   */
  upgrade?: (
    req: http.IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer,
  ) => boolean;
  /**
   * First look at every HTTP request (after `/health`). Return true to claim
   * it — the server then leaves the response alone. The `upgrade` hook's
   * HTTP twin: lets an embedder (the platform's guest harness) add its own
   * HTTP surface — the studio coding agent's chat endpoint — without a
   * second HTTP server.
   */
  request?: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: string,
    method: string,
  ) => boolean;
};

/** Handle returned by {@link createServer}. */
export type AgentServer = {
  /**
   * Start listening. `host` defaults to {@link DEFAULT_LISTEN_HOST} (loopback)
   * — pass `"0.0.0.0"` to deliberately expose the server on other interfaces.
   */
  listen(port?: number, host?: string): Promise<void>;
  close(): Promise<void>;
  port: number | undefined;
};

/**
 * Default bind address. Loopback, not every interface: this server has no
 * request authentication of its own, so binding `0.0.0.0` by default put a
 * developer's agent — and the provider credentials backing it — in reach of
 * anyone on the same network (a shared office or cafe LAN). Exposing it is now
 * an explicit choice by the caller.
 */
export const DEFAULT_LISTEN_HOST = "127.0.0.1";

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

/**
 * Separator-safe containment: `target` is `dir` itself or strictly inside it.
 *
 * A bare `target.startsWith(dir)` also admits sibling directories sharing the
 * prefix (`<dir>-evil`) — the classic path-containment bug. Both paths must
 * already be resolved; this is a pure string check.
 *
 * @internal
 */
export function isPathInside(dir: string, target: string): boolean {
  return target === dir || target.startsWith(dir + path.sep);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

async function serveStatic(
  dir: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  logger: Logger,
): Promise<boolean> {
  const url = req.url?.split("?")[0] ?? "/";
  const filePath = path.join(dir, url === "/" ? "index.html" : url);

  // Resolve before the containment check to avoid prefix collisions
  // (e.g. dir="/app/static" matching "/app/static-secrets/…").
  const resolved = path.resolve(dir);
  if (!isPathInside(resolved, filePath)) return false;

  // Only pre-response failures (ENOENT, EACCES, a directory) return false —
  // the caller then writes the 404. Once headers go out below, every failure
  // must be handled here: falling through would write on a broken response.
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const ext = path.extname(filePath).toLowerCase();
  const mime = mimeLookup(ext) || "application/octet-stream";
  try {
    res.writeHead(200, { "Content-Type": mime, "Content-Length": stat.size });
  } catch (err) {
    // Response already broken (headers sent / destroyed) — claim the request
    // so the caller doesn't try to write a 404 on it too.
    logger.error("serveStatic: response unusable", { error: errorMessage(err) });
    res.destroy();
    return true;
  }
  const stream = fs.createReadStream(filePath);
  stream.on("error", (err) => {
    // Headers are already sent — destroy so the client sees a truncated
    // body instead of a hang (and the read stream is released).
    logger.error("serveStatic: read stream failed", { error: errorMessage(err) });
    res.destroy(err);
  });
  stream.pipe(res);
  return true;
}

/**
 * Create an HTTP + WebSocket server for an agent — the self-hosting entry
 * point, and the same server `aai dev` runs.
 *
 * Serves `GET /health`, `GET /client-config` (name/greeting for the browser
 * client), static client assets when `clientDir` is set, and voice sessions
 * on `WS /websocket`. {@link AgentServer.listen} binds loopback by default;
 * pass `"0.0.0.0"` to expose it deliberately (the server has no request
 * authentication of its own).
 *
 * @example
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { createRuntime, createServer } from "@alexkroman1/aai/runtime";
 *
 * const myAgent = agent({ name: "Support", systemPrompt: "…" });
 * const runtime = createRuntime({
 *   agent: myAgent,
 *   env: { ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY ?? "" },
 * });
 * const server = createServer({ runtime, name: myAgent.name });
 * await server.listen(3000);
 * ```
 *
 * @public
 */
export function createServer(options: ServerOptions): AgentServer {
  const { runtime, clientDir, logger = consoleLogger, env, hostBaseAgent } = options;
  const name = options.name ?? "agent";

  const defaultHtml = `<!DOCTYPE html><html><body><h1>${escapeHtml(name)}</h1><p>Agent server running.</p></body></html>`;

  // Pre-connection client config: how the default client should talk to
  // this agent (see sdk/client-config.ts).
  function sendClientConfig(res: http.ServerResponse): void {
    sendJson(res, 200, buildClientConfig({ name, greeting: options.greeting }));
  }

  async function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: string,
    method: string,
  ): Promise<void> {
    // Registered before static serving so a client asset can never shadow
    // the client-config endpoint.
    if (method === "GET" && url === `/${CLIENT_CONFIG_PATH}`) {
      sendClientConfig(res);
      return;
    }

    if (clientDir && (await serveStatic(clientDir, req, res, logger))) return;

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
    if (options.request?.(req, res, url, method)) return;
    handleRequest(req, res, url, method).catch((err: unknown) => {
      // A rejection here would otherwise be an unhandled rejection that can
      // take down the process; answer 500 when possible, else drop the socket.
      logger.error("Request handler failed", { error: errorMessage(err) });
      try {
        if (res.headersSent) {
          res.destroy();
        } else {
          sendJson(res, 500, { error: "Internal server error" });
        }
      } catch {
        res.destroy();
      }
    });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });

  httpServer.on("upgrade", (req, socket, head) => {
    // Node removes its own socket error listener before emitting `upgrade`;
    // without one, a client RST before ws attaches its handler becomes an
    // unhandled `error` → uncaughtException that can take down the host.
    socket.on("error", () => {
      /* surfaced via close; presence prevents an uncaught throw */
    });

    if (options.upgrade?.(req, socket, head)) return;

    const url = req.url?.split("?")[0] ?? "";
    if (!url.startsWith("/websocket")) {
      // No other upgrade consumer exists on this server: an unmatched upgrade
      // socket would otherwise dangle forever with no error handling.
      socket.destroy();
      return;
    }

    const params = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
    const wantsHost = params.has("host");

    wss.handleUpgrade(req, socket, head, (ws) => {
      const startOpts = parseWsUpgradeParams(req.url ?? "");
      const session = ws as unknown as SessionWebSocket;

      // Host mode: defer startSession until the first `config` frame supplies
      // the per-connection agent. Requires `env` (for gating + secrets).
      if (wantsHost && env && isHostAllowed(env)) {
        logger.info(`WS upgrade ${url} (host mode)`);
        startHostSession(session, {
          env,
          startOpts,
          logger,
          ...(hostBaseAgent ? { baseAgent: hostBaseAgent } : {}),
        });
        return;
      }
      if (wantsHost) {
        logger.warn(`WS upgrade ${url} rejected: host mode unavailable`);
        safeSend(
          session,
          JSON.stringify({
            type: "error",
            code: "protocol",
            message: "host mode is not enabled on this server",
          }),
          logger,
        );
        (ws as unknown as { close?: (code?: number) => void }).close?.(1008);
        return;
      }

      logger.info(`WS upgrade ${url}${startOpts.skipGreeting ? " (resume)" : ""}`);
      runtime.startSession(session, startOpts);
    });
  });

  let listenPort: number | undefined;

  // Post-listen server errors have no promise to reject into (listen()'s
  // one-shot reject is removed once bound) — log instead of crashing on an
  // unhandled 'error' event.
  httpServer.on("error", (err) => {
    logger.error("HTTP server error", { error: errorMessage(err) });
  });

  return {
    get port() {
      return listenPort;
    },

    async listen(port = 3000, host = DEFAULT_LISTEN_HOST) {
      await new Promise<void>((resolve, reject) => {
        // `once` + removal on success: a persistent reject here would pile up
        // one listener per listen() call and reject a long-settled promise.
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => {
          httpServer.removeListener("error", reject);
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
          // runtime.shutdown() closes the provider transports but not the
          // client sockets, and wss.close() on a noServer WebSocketServer does
          // not terminate existing connections. Without this, httpServer.close()
          // waits forever for an upgraded client socket to end (dev/CLI shutdown
          // hangs whenever a browser tab is still connected).
          for (const client of wss.clients) client.terminate();
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
