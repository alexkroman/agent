// Copyright 2025 the AAI authors. MIT license.
/**
 * Self-hostable agent server.
 *
 * `createServer()` returns a server with `listen()` for HTTP + WebSocket.
 * Calls `createDirectExecutor` + `wireSessionSocket` directly — no
 * intermediate WintercServer layer.
 */

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { WebSocketServer } from "ws";
import { createDirectExecutor } from "./direct-executor.ts";
import type { Kv } from "./kv.ts";
import { buildReadyConfig } from "./protocol.ts";
import type { Logger, S2SConfig } from "./runtime.ts";
import { consoleLogger, DEFAULT_S2S_CONFIG } from "./runtime.ts";
import type { Session } from "./session.ts";
import type { AgentDef } from "./types.ts";
import { filterEnv } from "./utils.ts";
import { type SessionWebSocket, wireSessionSocket } from "./ws-handler.ts";

/**
 * Options for creating a self-hosted agent server.
 * @public
 */
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
  /**
   * Allowed origins for WebSocket connections. When set, the server validates
   * the `Origin` header on upgrade requests and rejects connections from
   * origins not in this list.
   *
   * Defaults to the server's own origin (`http://localhost:<port>`).
   * Pass `"*"` to allow any origin (disables validation).
   */
  allowedOrigins?: string[] | "*";
};

/**
 * Handle returned by {@link createServer}.
 * @public
 */
export type AgentServer = {
  /** Start listening on the given port. */
  listen(port?: number): Promise<void>;
  /** Stop the server. */
  close(): Promise<void>;
};

/** @internal Escape HTML special characters to prevent XSS. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Create a self-hostable agent server.
 * @public
 */
export function createServer(options: ServerOptions): AgentServer {
  const {
    agent,
    kv,
    clientHtml,
    clientDir,
    logger = consoleLogger,
    s2sConfig = DEFAULT_S2S_CONFIG,
    allowedOrigins,
  } = options;

  const env = filterEnv(options.env ?? (typeof process !== "undefined" ? process.env : {}));

  const executor = createDirectExecutor({ agent, env, ...(kv ? { kv } : {}), logger, s2sConfig });
  const sessions = new Map<string, Session>();
  const readyConfig = buildReadyConfig(s2sConfig);

  function handleWs(ws: SessionWebSocket, skipGreeting: boolean): void {
    wireSessionSocket(ws, {
      sessions,
      createSession: (sid, client) =>
        executor.createSession({ id: sid, agent: agent.name, client, skipGreeting }),
      readyConfig,
      logger,
    });
  }

  let serverHandle: { shutdown(): Promise<void> } | null = null;

  return {
    async listen(port = 3000) {
      if (serverHandle) throw new Error("Server is already listening");

      const app = new Hono();

      app.onError((err, c) => {
        logger.error(`${c.req.method} ${new URL(c.req.url).pathname} error: ${err.message}`);
        return c.json({ error: "Internal Server Error" }, 500);
      });

      app.use("/*", async (c, next) => {
        const start = Date.now();
        await next();
        const ms = Date.now() - start;
        const { status } = c.res;
        const method = c.req.method;
        const path = new URL(c.req.url).pathname;
        if (status >= 400) {
          logger.error(`${method} ${path} ${status} ${ms}ms`);
        } else {
          logger.info(`${method} ${path} ${status} ${ms}ms`);
        }
      });

      app.get("/health", (c) => c.json({ status: "ok", name: agent.name }));

      if (clientDir) {
        app.use("/*", serveStatic({ root: clientDir }));
      }

      app.get("/", (c) => {
        if (clientHtml) return c.html(clientHtml);
        const safeName = escapeHtml(agent.name);
        return c.html(
          `<!DOCTYPE html><html><body><h1>${safeName}</h1><p>Agent server running.</p></body></html>`,
        );
      });

      const nodeServer = serve({ fetch: app.fetch, port });

      await new Promise<void>((resolve, reject) => {
        nodeServer.on("listening", resolve);
        nodeServer.on("error", reject);
      });

      const wss = new WebSocketServer({ noServer: true });

      // Build the set of allowed origins for WebSocket upgrade validation.
      const effectiveAllowedOrigins =
        allowedOrigins === "*"
          ? null // null means allow any origin
          : new Set(allowedOrigins ?? [`http://localhost:${port}`, `http://127.0.0.1:${port}`]);

      nodeServer.on("upgrade", (req, socket, head) => {
        const origin = req.headers.origin ?? "";

        // Reject cross-origin WebSocket connections. Requests with no Origin
        // header (non-browser clients) are allowed through.
        if (
          effectiveAllowedOrigins !== null &&
          origin !== "" &&
          !effectiveAllowedOrigins.has(origin)
        ) {
          logger.error(`WS upgrade rejected: origin "${origin}" not allowed`);
          socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
          socket.destroy();
          return;
        }

        const reqUrl = new URL(req.url ?? "/", `http://localhost:${port}`);
        const resume = reqUrl.searchParams.has("resume");
        logger.info(`WS upgrade ${reqUrl.pathname}${resume ? " (resume)" : ""}`);
        wss.handleUpgrade(req, socket, head, (ws) => {
          handleWs(ws, resume);
        });
      });

      serverHandle = {
        async shutdown() {
          await new Promise<void>((resolve, reject) => {
            wss.close((err) => (err ? reject(err) : resolve()));
          });
          await new Promise<void>((resolve, reject) => {
            nodeServer.close((err) => (err ? reject(err) : resolve()));
          });
        },
      };
    },

    async close() {
      if (sessions.size > 0) {
        await Promise.allSettled([...sessions.values()].map((s) => s.stop()));
        sessions.clear();
      }
      await serverHandle?.shutdown();
    },
  };
}
