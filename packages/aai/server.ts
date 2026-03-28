// Copyright 2025 the AAI authors. MIT license.
/**
 * Self-hostable agent server.
 *
 * {@link createAgentApp} returns a composable Hono app that can be mounted
 * into a larger application. {@link createServer} wraps it with `listen()`
 * and `close()` for standalone deployments.
 */

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { html } from "hono/html";
import { logger as honoLogger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { createStorage, type Storage } from "unstorage";
import {
  AGENT_CSP,
  DEFAULT_SESSION_START_TIMEOUT_MS,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
} from "./constants.ts";
import { createDirectExecutor } from "./direct-executor.ts";
import type { Logger, S2SConfig } from "./runtime.ts";
import { consoleLogger, DEFAULT_S2S_CONFIG } from "./runtime.ts";
import type { AgentDef } from "./types.ts";
import { createUnstorageKv } from "./unstorage-kv.ts";

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
   * Unstorage instance for KV storage. Defaults to in-memory.
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
 * Result of {@link createAgentApp}. Contains the Hono app and a shutdown
 * function to gracefully stop active sessions.
 *
 * @public
 */
export type AgentApp = {
  /** Hono app with agent routes. Mount it or add your own middleware. */
  app: Hono;
  /** Wire WebSocket support into a Node HTTP server. */
  injectWebSocket: (server: ReturnType<typeof serve>) => void;
  /** Gracefully stop all active sessions and release resources. */
  shutdown(): Promise<void>;
};

/**
 * Create a composable Hono app with agent routes and WebSocket handling.
 *
 * Use this when you want to embed agent routes into a larger Hono app,
 * add custom middleware, or compose with other services. For standalone
 * deployments, use {@link createServer} instead.
 *
 * @example Mount into your own Hono app
 * ```ts
 * import { Hono } from "hono";
 * import { createAgentApp } from "@alexkroman1/aai/server";
 *
 * const { app: agentApp, shutdown } = createAgentApp({ agent });
 * const app = new Hono();
 * app.route("/agent", agentApp);
 * app.get("/custom", (c) => c.text("hello"));
 * ```
 *
 * @public
 */
export function createAgentApp(options: ServerOptions): AgentApp {
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
    shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  } = options;

  const rawEnv = options.env ?? (typeof process !== "undefined" ? process.env : {});
  const env = Object.fromEntries(
    Object.entries(rawEnv).filter((e): e is [string, string] => e[1] !== undefined),
  );
  const storage = options.storage ?? createStorage();
  const kv = createUnstorageKv({ storage });

  const runtime = createDirectExecutor({
    agent,
    env,
    kv,
    logger,
    s2sConfig,
    sessionStartTimeoutMs: options.sessionStartTimeoutMs ?? DEFAULT_SESSION_START_TIMEOUT_MS,
    shutdownTimeoutMs,
  });

  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  app.notFound((c) => c.json({ error: "Not found" }, 404));

  app.onError((err, c) => {
    logger.error(`${c.req.method} ${c.req.path} error: ${err.message}`);
    return c.json({ error: "Internal Server Error" }, 500);
  });

  // Strip ANSI escape codes (hono/logger may colorize the status)
  const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[\\d+m`, "g");
  app.use(
    "*",
    honoLogger((msg: string) => {
      // hono/logger format: "<-- GET /" or "--> GET / 404 12ms"
      const clean = msg.replace(ansiPattern, "");
      const statusMatch = clean.match(/--> \w+ \S+ (\d{3})/);
      const status = statusMatch ? Number(statusMatch[1]) : 0;
      if (status >= 400) {
        logger.error(msg);
      } else {
        logger.info(msg);
      }
    }),
  );

  app.use("*", secureHeaders());
  app.use("*", (c, next) => {
    c.header("Content-Security-Policy", AGENT_CSP);
    return next();
  });

  app.get("/health", (c) => c.json({ status: "ok", name: agent.name }));

  app.get("/kv", async (c) => {
    const key = c.req.query("key");
    if (!key) return c.json({ error: "Missing key query parameter" }, 400);
    const value = await kv.get(key);
    if (value === null) return c.json(null, 404);
    return c.json(value);
  });

  if (clientDir) {
    app.use("*", serveStatic({ root: clientDir }));
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
          if (ws.raw)
            runtime.startSession(ws.raw, {
              skipGreeting,
              ...(resumeFrom ? { resumeFrom } : {}),
            });
        },
      };
    }),
  );

  return {
    app,
    injectWebSocket,
    shutdown: () => runtime.shutdown(),
  };
}

/**
 * Create an HTTP + WebSocket server for self-hosted agent deployments.
 *
 * For composable usage (mounting into your own Hono app), use
 * {@link createAgentApp} instead.
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
  const { app, injectWebSocket, shutdown } = createAgentApp(options);

  let serverHandle: { shutdown(): Promise<void> } | null = null;
  let listenPort: number | undefined;

  return {
    get port() {
      return listenPort;
    },
    async listen(port = 3000) {
      if (serverHandle) throw new Error("Server is already listening");

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
      await shutdown();
      await serverHandle?.shutdown();
      listenPort = undefined;
    },
  };
}
