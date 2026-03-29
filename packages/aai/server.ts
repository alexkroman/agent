// Copyright 2025 the AAI authors. MIT license.
/**
 * Self-hostable agent server.
 *
 * {@link createAgentApp} returns a composable Hono app that can be mounted
 * into a larger application. {@link createServer} wraps it with `listen()`
 * and `close()` for standalone deployments.
 *
 * Both accept a pre-built {@link Runtime} from {@link createRuntime}, keeping
 * the execution engine separate from the HTTP transport layer.
 */

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import nodeAdapter from "crossws/adapters/node";
import { Hono } from "hono";
import { html } from "hono/html";
import { logger as honoLogger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { AGENT_CSP } from "./constants.ts";
import type { Runtime } from "./direct-executor.ts";
import type { Kv } from "./kv.ts";
import type { Logger } from "./runtime.ts";
import { consoleLogger } from "./runtime.ts";

export { createRuntime, type Runtime, type RuntimeOptions } from "./direct-executor.ts";

/**
 * Configuration for the server layer ({@link createServer} / {@link createAgentApp}).
 *
 * The agent runtime must be created separately via `createRuntime()` and
 * passed in. This keeps execution concerns separate from transport concerns.
 *
 * @public
 */
export type ServerOptions = {
  /** The agent runtime created by `createRuntime()`. */
  runtime: Runtime;
  /** Agent name shown in health endpoint and default HTML. */
  name?: string;
  /** KV store for the optional `GET /kv` endpoint. */
  kv?: Kv;
  /** HTML to serve at `GET /`. */
  clientHtml?: string;
  /** Directory containing built client files (index.html + assets/). */
  clientDir?: string;
  /** Logger. Defaults to console. */
  logger?: Logger;
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
 * import { createRuntime } from "@alexkroman1/aai/server";
 * import { createAgentApp } from "@alexkroman1/aai/server";
 *
 * const runtime = createRuntime({ agent, env: process.env });
 * const { app: agentApp, shutdown } = createAgentApp({ runtime });
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
  const { runtime, clientHtml, clientDir, logger = consoleLogger, kv } = options;
  const name = options.name ?? "agent";

  const app = new Hono();

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

  app.get("/health", (c) => c.json({ status: "ok", name }));

  if (kv) {
    app.get("/kv", async (c) => {
      const key = c.req.query("key");
      if (!key) return c.json({ error: "Missing key query parameter" }, 400);
      const value = await kv.get(key);
      if (value === null) return c.json(null, 404);
      return c.json(value);
    });
  }

  if (clientDir) {
    app.use("*", serveStatic({ root: clientDir }));
  }

  app.get("/", (c) => {
    if (clientHtml) return c.html(clientHtml);
    return c.html(
      html`<!DOCTYPE html><html><body><h1>${name}</h1><p>Agent server running.</p></body></html>`,
    );
  });

  const wsAdapter = nodeAdapter({
    hooks: {
      open(peer) {
        const reqUrl = peer.request?.url ?? "/";
        const qIdx = reqUrl.indexOf("?");
        const search = qIdx >= 0 ? reqUrl.slice(qIdx + 1) : "";
        const getParam = (key: string): string | undefined => {
          const re = new RegExp(`(?:^|&)${key}=([^&]*)`);
          const m = search.match(re);
          return m?.[1] ? decodeURIComponent(m[1]) : undefined;
        };
        const hasParam = (key: string): boolean => search.includes(key);
        const resumeFrom = getParam("sessionId");
        const skipGreeting = hasParam("resume") || resumeFrom !== undefined;
        const pathname = qIdx >= 0 ? reqUrl.slice(0, qIdx) : reqUrl;
        logger.info(`WS upgrade ${pathname}${skipGreeting ? " (resume)" : ""}`);
        const rawWs = peer.websocket as unknown as import("./ws-handler.ts").SessionWebSocket;
        runtime.startSession(rawWs, {
          skipGreeting,
          ...(resumeFrom ? { resumeFrom } : {}),
        });
      },
    },
  });

  return {
    app,
    injectWebSocket: (server: ReturnType<typeof serve>) => {
      // biome-ignore lint/suspicious/noExplicitAny: ReturnType<typeof serve> is an HTTP server with upgrade event
      (server as any).on("upgrade", (req: { url?: string }, socket: unknown, head: unknown) => {
        if (req.url?.startsWith("/websocket")) {
          wsAdapter.handleUpgrade(req as never, socket as never, head as never);
        }
      });
    },
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
 * import { createRuntime, createServer } from "@alexkroman1/aai/server";
 *
 * const agent = defineAgent({ name: "my-agent" });
 * const runtime = createRuntime({ agent });
 * const server = createServer({ runtime, name: agent.name });
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
