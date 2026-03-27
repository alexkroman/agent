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
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { html } from "hono/html";
import { secureHeaders } from "hono/secure-headers";
import { createStorage, type Storage } from "unstorage";
import { filterEnv } from "./_utils.ts";
import { createDirectExecutor } from "./direct-executor.ts";
import { buildReadyConfig } from "./protocol.ts";
import type { Logger, S2SConfig } from "./runtime.ts";
import { consoleLogger, DEFAULT_S2S_CONFIG } from "./runtime.ts";
import type { Session } from "./session.ts";
import type { AgentDef } from "./types.ts";
import { createUnstorageKv } from "./unstorage-kv.ts";
import { createUnstorageVectorStore } from "./unstorage-vector.ts";
import { type SessionWebSocket, wireSessionSocket } from "./ws-handler.ts";

/**
 * Configuration for a self-hosted agent server created by {@link createServer}.
 *
 * @public
 */
export type ServerOptions = {
  /** The agent definition returned by `defineAgent()`. */
  // biome-ignore lint/suspicious/noExplicitAny: accepts any state type
  agent: AgentDef<any>;
  /** Environment variables. Defaults to `process.env`. */
  env?: Record<string, string>;
  /**
   * Unstorage instance for KV and vector storage. Defaults to in-memory.
   * Configure with an S3/R2/filesystem driver for persistence.
   */
  storage?: Storage;
  /** HTML to serve at `GET /`. */
  clientHtml?: string;
  /** Directory containing built client files (index.html + assets/). */
  clientDir?: string;
  /** Logger. Defaults to console. */
  logger?: Logger;
  /** S2S configuration. Defaults to AssemblyAI production. */
  s2sConfig?: S2SConfig;
  /**
   * Timeout in ms for `session.start()` (S2S connection setup).
   * Defaults to 10 000 (10 s). If the session doesn't initialize within
   * this window the connection is cleaned up.
   */
  sessionStartTimeoutMs?: number;
  /**
   * Maximum time in milliseconds to wait for sessions to stop during
   * {@link AgentServer.close | close()}. Sessions still running after this
   * deadline are force-closed. Defaults to `30_000` (30 seconds).
   */
  shutdownTimeoutMs?: number;
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
async function drainSessions(
  sessions: Map<string, Session>,
  shutdownTimeoutMs: number,
  logger: Logger,
): Promise<void> {
  if (sessions.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(resolve, shutdownTimeoutMs, "timeout");
  });
  const graceful = Promise.allSettled([...sessions.values()].map((s) => s.stop())).then(
    (results) => {
      for (const r of results) {
        if (r.status === "rejected") logger.warn(`Session stop failed during close: ${r.reason}`);
      }
      return "done" as const;
    },
  );
  const outcome = await Promise.race([graceful, timeout]);
  if (timer) clearTimeout(timer);
  if (outcome === "timeout") {
    logger.warn(
      `Shutdown timeout (${shutdownTimeoutMs}ms) exceeded — force-closing ${sessions.size} remaining session(s)`,
    );
  }
  sessions.clear();
}

export function createServer(options: ServerOptions): AgentServer {
  if (options.clientHtml && options.clientDir) {
    throw new Error(
      "ServerOptions: clientHtml and clientDir are mutually exclusive — provide one or the other, not both.",
    );
  }
  const {
    agent,
    clientHtml,
    clientDir,
    logger = consoleLogger,
    s2sConfig = DEFAULT_S2S_CONFIG,
    shutdownTimeoutMs = 30_000,
  } = options;

  const env = filterEnv(options.env ?? (typeof process !== "undefined" ? process.env : {}));
  const storage = options.storage ?? createStorage();
  const kv = createUnstorageKv({ storage });
  const vector = createUnstorageVectorStore({ storage });

  const executor = createDirectExecutor({
    agent,
    env,
    kv,
    vector,
    logger,
    s2sConfig,
  });
  const sessions = new Map<string, Session>();
  const readyConfig = buildReadyConfig(s2sConfig);

  function handleWs(ws: SessionWebSocket, skipGreeting: boolean, resumeFrom?: string): void {
    wireSessionSocket(ws, {
      sessions,
      createSession: (sid, client) =>
        executor.createSession({
          id: sid,
          agent: agent.name,
          client,
          skipGreeting,
          ...(resumeFrom ? { resumeFrom } : {}),
        }),
      readyConfig,
      logger,
      ...(options.sessionStartTimeoutMs !== undefined
        ? { sessionStartTimeoutMs: options.sessionStartTimeoutMs }
        : {}),
      ...(resumeFrom ? { resumeFrom } : {}),
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
      const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

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

      app.use(
        "*",
        secureHeaders({
          contentSecurityPolicy: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "blob:"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            connectSrc: ["'self'", "wss:", "ws:"],
            imgSrc: ["'self'", "data:"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
          },
        }),
      );

      app.get("/health", (c) => c.json({ status: "ok", name: agent.name }));

      app.get("/kv", async (c) => {
        const key = c.req.query("key");
        if (!key) return c.json({ error: "Missing key query parameter" }, 400);
        const value = await kv.get(key);
        if (value === null) return c.json(null, 404);
        return c.json(value);
      });

      if (clientDir) {
        app.use("/*", serveStatic({ root: clientDir }));
      }

      app.get("/", (c) => {
        if (clientHtml) return c.html(clientHtml);
        return c.html(
          html`<!DOCTYPE html><html><body><h1>${agent.name}</h1><p>Agent server running.</p></body></html>`,
        );
      });

      app.get(
        "/websocket",
        upgradeWebSocket((c) => {
          const resumeFrom = c.req.query("sessionId") ?? undefined;
          const skipGreeting = c.req.query("resume") !== undefined || resumeFrom !== undefined;
          logger.info(`WS upgrade ${c.req.path}${skipGreeting ? " (resume)" : ""}`);
          return {
            onOpen(_evt, ws) {
              if (ws.raw) handleWs(ws.raw, skipGreeting, resumeFrom);
            },
          };
        }),
      );

      const nodeServer = serve({ fetch: app.fetch, port });
      injectWebSocket(nodeServer);

      await new Promise<void>((resolve, reject) => {
        nodeServer.on("listening", resolve);
        nodeServer.on("error", reject);
      });

      const addr = nodeServer.address();
      listenPort = typeof addr === "object" && addr ? addr.port : port;

      serverHandle = {
        async shutdown() {
          await new Promise<void>((resolve, reject) => {
            nodeServer.close((err) => (err ? reject(err) : resolve()));
          });
        },
      };
    },

    async close() {
      await drainSessions(sessions, shutdownTimeoutMs, logger);
      await serverHandle?.shutdown();
      listenPort = undefined;
    },
  };
}
