// Copyright 2025 the AAI authors. MIT license.
/**
 * Self-hostable agent server.
 *
 * `createServer()` takes an `AgentDef` and returns a WinterCG-compatible
 * server that can run on Node.js or Docker.
 *
 * @module
 */

import type { AgentConfig } from "./_internal_types.ts";
import { createDirectExecutor } from "./direct_executor.ts";
import type { Kv } from "./kv.ts";
import { AUDIO_FORMAT, PROTOCOL_VERSION } from "./protocol.ts";
import type { Logger, S2SConfig } from "./runtime.ts";
import { consoleLogger, DEFAULT_S2S_CONFIG } from "./runtime.ts";
import type { CreateS2sWebSocket, S2sWebSocket } from "./s2s.ts";
import { createS2sSession, type Session } from "./session.ts";
import type { AgentDef } from "./types.ts";
import { wireSessionSocket } from "./ws_handler.ts";

export type ServerOptions = {
  /** The agent definition returned by `defineAgent()`. */
  agent: AgentDef;
  /** Environment variables. Defaults to `process.env`. */
  env?: Record<string, string>;
  /** KV store. Defaults to in-memory. */
  kv?: Kv;
  /** HTML to serve at `GET /`. */
  clientHtml?: string;
  /** Logger. Defaults to console. */
  logger?: Logger;
  /** S2S configuration. Defaults to AssemblyAI production. */
  s2sConfig?: S2SConfig;
  /** WebSocket factory for S2S connections. Auto-detected if not provided. */
  createWebSocket?: CreateS2sWebSocket;
};

export type AgentServer = {
  /** WinterCG-compatible fetch handler. */
  fetch(request: Request): Promise<Response>;
  /** Start listening on the given port. */
  listen(port?: number): Promise<void>;
  /** Stop the server. */
  close(): Promise<void>;
};

/** Build a serializable AgentConfig from an AgentDef. */
function buildAgentConfig(agent: AgentDef): AgentConfig {
  const config: AgentConfig = {
    name: agent.name,
    instructions: agent.instructions,
    greeting: agent.greeting,
    voice: agent.voice,
  };
  if (agent.sttPrompt !== undefined) config.sttPrompt = agent.sttPrompt;
  if (typeof agent.maxSteps !== "function") config.maxSteps = agent.maxSteps;
  if (agent.toolChoice !== undefined) config.toolChoice = agent.toolChoice;
  if (agent.builtinTools) config.builtinTools = [...agent.builtinTools];
  if (agent.activeTools) config.activeTools = [...agent.activeTools];
  return config;
}

/** Try to load the `ws` package for WebSocket connections. */
async function loadWsFactory(): Promise<CreateS2sWebSocket> {
  try {
    const mod = await import("ws");
    const WS = mod.default ?? mod;
    return (url: string, opts: { headers: Record<string, string> }) =>
      new WS(url, { headers: opts.headers }) as unknown as S2sWebSocket;
  } catch {
    throw new Error(
      "WebSocket factory not provided and `ws` package not found. " +
        "Install `ws` (`npm install ws`) or pass `createWebSocket` option.",
    );
  }
}

/** Filter env to only defined string values. */
function resolveEnv(env: Record<string, string | undefined>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) resolved[key] = value;
  }
  return resolved;
}

/**
 * Create a self-hostable agent server.
 *
 * @example
 * ```ts
 * import { defineAgent } from "aai";
 * import { createServer } from "aai/server";
 *
 * const agent = defineAgent({ name: "my-agent" });
 * const server = createServer({ agent });
 * await server.listen(3000);
 * ```
 */
export function createServer(options: ServerOptions): AgentServer {
  const { agent, kv, clientHtml, logger = consoleLogger, s2sConfig = DEFAULT_S2S_CONFIG } = options;

  const env = resolveEnv(
    options.env ?? (typeof process !== "undefined" ? (process.env as Record<string, string>) : {}),
  );

  const executor = createDirectExecutor({ agent, env, ...(kv ? { kv } : {}) });
  const sessions = new Map<string, Session>();
  const agentConfig = buildAgentConfig(agent);
  const apiKey = env.ASSEMBLYAI_API_KEY ?? "";

  let wsFactory: CreateS2sWebSocket | null = options.createWebSocket ?? null;

  async function getWsFactory(): Promise<CreateS2sWebSocket> {
    if (!wsFactory) {
      wsFactory = await loadWsFactory();
    }
    return wsFactory;
  }

  function createSessionForWs(
    sessionId: string,
    client: import("./protocol.ts").ClientSink,
    skipGreeting: boolean,
  ): Session {
    if (!wsFactory) {
      throw new Error("WebSocket factory not initialized");
    }
    return createS2sSession({
      id: sessionId,
      agent: agent.name,
      client,
      agentConfig,
      toolSchemas: executor.toolSchemas,
      apiKey,
      s2sConfig,
      executeTool: executor.executeTool,
      createWebSocket: wsFactory,
      hookInvoker: executor.hookInvoker,
      skipGreeting,
      logger,
    });
  }

  const readyConfig = {
    protocolVersion: PROTOCOL_VERSION,
    audioFormat: AUDIO_FORMAT,
    sampleRate: s2sConfig.inputSampleRate,
    ttsSampleRate: s2sConfig.outputSampleRate,
    mode: "s2s" as const,
  };

  let serverHandle: { shutdown(): Promise<void> } | null = null;

  async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", name: agent.name }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // WebSocket upgrade at /ws
    if (url.pathname === "/ws") {
      // Ensure WS factory is loaded
      await getWsFactory();
      const resume = url.searchParams.has("resume");

      // WebSocket upgrade is handled in listen() via the HTTP server's
      // "upgrade" event. Return 426 if called via fetch().
      return new Response("Use WebSocket upgrade", { status: 426 });
    }

    // Serve client HTML at root
    if (url.pathname === "/" && clientHtml) {
      return new Response(clientHtml, {
        headers: { "Content-Type": "text/html" },
      });
    }

    // Default landing page if no clientHtml
    if (url.pathname === "/") {
      return new Response(
        `<!DOCTYPE html><html><body><h1>${agent.name}</h1><p>Agent server running.</p></body></html>`,
        { headers: { "Content-Type": "text/html" } },
      );
    }

    return new Response("Not Found", { status: 404 });
  }

  return {
    fetch: handleRequest,

    async listen(port = 3000) {
      // Ensure WS factory is loaded before starting
      await getWsFactory();

      const http = await import("node:http");

      const nodeServer = http.createServer(async (req, res) => {
        try {
          const protocol = (req.socket as { encrypted?: boolean }).encrypted ? "https" : "http";
          const host = req.headers.host ?? `localhost:${port}`;
          const url = new URL(req.url ?? "/", `${protocol}://${host}`);
          const headers = new Headers();
          for (const [key, val] of Object.entries(req.headers)) {
            if (val) headers.set(key, Array.isArray(val) ? val[0]! : val);
          }
          const request = new Request(url, {
            method: req.method ?? "GET",
            headers,
          });
          const response = await handleRequest(request);
          res.writeHead(response.status, Object.fromEntries(response.headers));
          const body = await response.text();
          res.end(body);
        } catch (err: unknown) {
          res.writeHead(500);
          res.end(err instanceof Error ? err.message : "Internal Server Error");
        }
      });

      // WebSocket upgrade via ws package
      try {
        const wsMod = await import("ws");
        const WSServer = wsMod.WebSocketServer ?? wsMod.default?.Server;
        if (WSServer) {
          const wss = new WSServer({ noServer: true });
          nodeServer.on("upgrade", (req: unknown, socket: unknown, head: unknown) => {
            wss.handleUpgrade(
              req as Parameters<typeof wss.handleUpgrade>[0],
              socket as Parameters<typeof wss.handleUpgrade>[1],
              head as Parameters<typeof wss.handleUpgrade>[2],
              (ws: WebSocket) => {
                const reqUrl = new URL(
                  (req as { url?: string }).url ?? "/",
                  `http://localhost:${port}`,
                );
                const resume = reqUrl.searchParams.has("resume");
                wireSessionSocket(ws, {
                  sessions,
                  createSession: (sid, client) => createSessionForWs(sid, client, resume),
                  readyConfig,
                  logger,
                });
              },
            );
          });
        }
      } catch {
        logger.warn("ws package not available for Node.js WebSocket upgrade");
      }

      await new Promise<void>((resolve) => {
        nodeServer.listen(port, () => {
          logger.info(`Agent "${agent.name}" listening on http://localhost:${port}`);
          resolve();
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
      // Stop all active sessions
      for (const session of sessions.values()) {
        await session.stop();
      }
      sessions.clear();
      await serverHandle?.shutdown();
    },
  };
}
