// Copyright 2025 the AAI authors. MIT license.
/**
 * Self-hostable agent server.
 *
 * `createServer()` returns a server with `listen()` for HTTP + WebSocket.
 * Calls `createDirectExecutor` + `wireSessionSocket` directly — no
 * intermediary needed.
 */

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { WebSocketServer } from "ws";
import { filterEnv } from "./_utils.ts";
import { createDirectExecutor } from "./direct-executor.ts";
import type { Kv } from "./kv.ts";
import { buildReadyConfig } from "./protocol.ts";
import type { Logger, S2SConfig } from "./runtime.ts";
import { consoleLogger, DEFAULT_S2S_CONFIG } from "./runtime.ts";
import type { Session } from "./session.ts";
import type { AgentDef } from "./types.ts";
import { type SessionWebSocket, wireSessionSocket } from "./ws-handler.ts";

/**
 * Configuration for a self-hosted agent server created by {@link createServer}.
 *
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
};

/**
 * Handle returned by {@link createServer} with lifecycle methods to start
 * and stop the HTTP + WebSocket server.
 *
 * @public
 */
export type AgentServer = {
  /** Start listening on the given port. */
  listen(port?: number): Promise<void>;
  /** Stop the server. */
  close(): Promise<void>;
  /** The port the server is listening on, or `undefined` before `listen()`. */
  port: number | undefined;
};

/** Escape HTML special characters to prevent XSS (single-pass). */
const _escapeMap: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => _escapeMap[ch] as string);
}

/**
 * Create an HTTP + WebSocket server for self-hosted agent deployments.
 *
 * Sets up a Hono HTTP server with a `/health` endpoint and WebSocket upgrade
 * handling. Agent tools execute directly in-process via {@link createDirectExecutor}.
 *
 * @param options - Server configuration including the agent definition, optional
 *   KV store, client assets, logger, and S2S config. See {@link ServerOptions}.
 * @returns An {@link AgentServer} with `listen()` and `close()` lifecycle methods.
 *
 * @example
 * ```ts
 * import { defineAgent } from "@alexkroman1/aai";
 * import { createServer } from "@alexkroman1/aai/server";
 *
 * const agent = defineAgent({ name: "my-agent" });
 * const server = createServer({ agent });
 * await server.listen(3000);
 * ```
 *
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
  } = options;

  const env = filterEnv(options.env ?? (typeof process !== "undefined" ? process.env : {}));

  const executor = createDirectExecutor({ agent, env, ...(kv ? { kv } : {}), logger, s2sConfig });
  const sessions = new Map<string, Session>();
  const readyConfig = buildReadyConfig(s2sConfig);
  const safeAgentName = escapeHtml(agent.name);

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
  let listenPort: number | undefined;

  return {
    get port() {
      return listenPort;
    },
    async listen(port = 3000) {
      if (serverHandle) throw new Error("Server is already listening");

      const app = new Hono();

      app.onError((err, c) => {
        logger.error(`${c.req.method} ${c.req.path} error: ${err.message}`);
        return c.json({ error: "Internal Server Error" }, 500);
      });

      app.use("/*", async (c, next) => {
        const start = Date.now();
        await next();
        const ms = Date.now() - start;
        const { status } = c.res;
        const method = c.req.method;
        const path = c.req.path;
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
        return c.html(
          `<!DOCTYPE html><html><body><h1>${safeAgentName}</h1><p>Agent server running.</p></body></html>`,
        );
      });

      const nodeServer = serve({ fetch: app.fetch, port });

      await new Promise<void>((resolve, reject) => {
        nodeServer.on("listening", resolve);
        nodeServer.on("error", reject);
      });

      const addr = nodeServer.address();
      listenPort = typeof addr === "object" && addr ? addr.port : port;

      const wss = new WebSocketServer({ noServer: true });
      nodeServer.on("upgrade", (req, socket, head) => {
        const reqUrl = new URL(req.url ?? "/", `http://localhost:${listenPort}`);
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
      listenPort = undefined;
    },
  };
}
