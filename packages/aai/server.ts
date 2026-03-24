// Copyright 2025 the AAI authors. MIT license.
/**
 * Self-hostable agent server.
 *
 * `createServer()` returns a server with `listen()` for HTTP + WebSocket.
 * Calls `createDirectExecutor` + `wireSessionSocket` directly — no
 * intermediate WintercServer layer.
 *
 * @module
 */

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { WebSocketServer } from "ws";
import { createDirectExecutor } from "./direct_executor.ts";
import type { Kv } from "./kv.ts";
import { AUDIO_FORMAT } from "./protocol.ts";
import type { Logger, S2SConfig } from "./runtime.ts";
import { consoleLogger, DEFAULT_S2S_CONFIG } from "./runtime.ts";
import type { Session } from "./session.ts";
import type { AgentDef } from "./types.ts";
import { type SessionWebSocket, wireSessionSocket } from "./ws_handler.ts";

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

export type AgentServer = {
  /** Start listening on the given port. */
  listen(port?: number): Promise<void>;
  /** Stop the server. */
  close(): Promise<void>;
};

function resolveEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<
    string,
    string
  >;
}

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

  const executor = createDirectExecutor({ agent, env, ...(kv ? { kv } : {}), logger, s2sConfig });
  const sessions = new Map<string, Session>();
  const readyConfig = {
    audioFormat: AUDIO_FORMAT,
    sampleRate: s2sConfig.inputSampleRate,
    ttsSampleRate: s2sConfig.outputSampleRate,
  };

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
        return c.html(
          `<!DOCTYPE html><html><body><h1>${agent.name}</h1><p>Agent server running.</p></body></html>`,
        );
      });

      const nodeServer = serve({ fetch: app.fetch, port });

      await new Promise<void>((resolve) => {
        nodeServer.on("listening", resolve);
      });

      const wss = new WebSocketServer({ noServer: true });
      nodeServer.on("upgrade", (req, socket, head) => {
        const reqUrl = new URL(req.url ?? "/", `http://localhost:${port}`);
        const resume = reqUrl.searchParams.has("resume");
        logger.info(`WS upgrade ${reqUrl.pathname}${resume ? " (resume)" : ""}`);
        wss.handleUpgrade(req, socket, head, (ws) => {
          handleWs(ws as unknown as SessionWebSocket, resume);
        });
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
      for (const session of sessions.values()) {
        await session.stop();
      }
      sessions.clear();
      await serverHandle?.shutdown();
    },
  };
}
