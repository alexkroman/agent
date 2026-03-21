// Copyright 2025 the AAI authors. MIT license.
/**
 * WinterTC-compatible server factory.
 *
 * Creates a server with `fetch(Request): Response` and `handleWebSocket(ws)`
 * that can run both in-process (self-hosted) and inside a sandboxed Worker
 * (platform). This is the shared core for both modes.
 *
 * @module
 */

import { Hono } from "hono";
import { createDirectExecutor } from "./direct_executor.ts";
import type { Kv } from "./kv.ts";
import { createMemoryKv } from "./kv.ts";
import { AUDIO_FORMAT } from "./protocol.ts";
import type { Logger, Metrics, S2SConfig } from "./runtime.ts";
import { consoleLogger, DEFAULT_S2S_CONFIG, noopMetrics } from "./runtime.ts";
import type { CreateS2sWebSocket } from "./s2s.ts";
import type { Session } from "./session.ts";
import type { AgentDef } from "./types.ts";
import type { VectorStore } from "./vector.ts";
import { createMemoryVectorStore } from "./vector.ts";
import { type SessionWebSocket, wireSessionSocket } from "./ws_handler.ts";

export type WintercServerOptions = {
  /** The agent definition returned by `defineAgent()`. */
  agent: AgentDef;
  /** Environment variables. */
  env: Record<string, string>;
  /** KV store. Defaults to in-memory. */
  kv?: Kv;
  /** Vector store. Defaults to in-memory. */
  vector?: VectorStore;
  /** Vector search function (legacy, used by builtin tool). */
  vectorSearch?: ((query: string, topK: number) => Promise<string>) | undefined;
  /** WebSocket factory for S2S connections. */
  createWebSocket: CreateS2sWebSocket;
  /** HTML to serve at `GET /`. */
  clientHtml?: string;
  /** Logger. Defaults to console. */
  logger?: Logger;
  /** Metrics collector. Defaults to noop. */
  metrics?: Metrics;
  /** S2S configuration. Defaults to AssemblyAI production. */
  s2sConfig?: S2SConfig;
};

export type WintercServer = {
  /** Standard fetch handler for HTTP routes. */
  fetch(request: Request): Promise<Response>;
  /** Attach a WebSocket to a new session. */
  handleWebSocket(
    ws: SessionWebSocket,
    opts?: { skipGreeting?: boolean; uid?: string | undefined },
  ): void;
  /** Stop all active sessions. */
  close(): Promise<void>;
};

/**
 * Create a WinterTC-compatible server from an agent definition.
 *
 * The returned object has a standard `fetch` handler and a `handleWebSocket`
 * method. Self-hosted mode calls these directly; platform mode calls them
 * from inside a sandboxed Worker via capnweb RPC.
 */
export function createWintercServer(options: WintercServerOptions): WintercServer {
  const {
    agent,
    env,
    kv = createMemoryKv(),
    vector = createMemoryVectorStore(),
    vectorSearch,
    clientHtml,
    logger = consoleLogger,
    metrics = noopMetrics,
    s2sConfig = DEFAULT_S2S_CONFIG,
  } = options;

  const executor = createDirectExecutor({
    agent,
    env,
    kv,
    vector,
    ...(vectorSearch ? { vectorSearch } : {}),
    createWebSocket: options.createWebSocket,
    logger,
    metrics,
    s2sConfig,
  });

  const sessions = new Map<string, Session>();

  const readyConfig = {
    audioFormat: AUDIO_FORMAT,
    sampleRate: s2sConfig.inputSampleRate,
    ttsSampleRate: s2sConfig.outputSampleRate,
  };

  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok", name: agent.name }));

  app.get("/", (c) => {
    if (clientHtml) {
      return c.html(clientHtml);
    }
    return c.html(
      `<!DOCTYPE html><html><body><h1>${agent.name}</h1><p>Agent server running.</p></body></html>`,
    );
  });

  return {
    async fetch(request: Request): Promise<Response> {
      return app.fetch(request);
    },

    handleWebSocket(ws: SessionWebSocket, wsOpts?: { skipGreeting?: boolean; uid?: string }): void {
      wireSessionSocket(ws, {
        sessions,
        createSession: (sid, client) =>
          executor.createSession({
            id: sid,
            agent: agent.name,
            client,
            skipGreeting: wsOpts?.skipGreeting ?? false,
          }),
        readyConfig,
        logger,
        uid: wsOpts?.uid,
      });
    },

    async close(): Promise<void> {
      for (const session of sessions.values()) {
        await session.stop();
      }
      sessions.clear();
    },
  };
}
