// Copyright 2025 the AAI authors. MIT license.
/**
 * Sandboxed worker entry point for platform mode.
 *
 * Called from the bundled `worker.js` inside a Deno Worker with all
 * permissions false. Monkeypatches `globalThis.fetch` to proxy through
 * capnweb RPC, creates capnweb-backed KV/vector/WebSocket, and delegates
 * to a {@linkcode WintercServer} for session management.
 *
 * @module
 */

import { z } from "zod";
import {
  BridgedWebSocket,
  CapnwebEndpoint,
  type CapnwebPort,
  deserializeResponse,
  type SerializedResponse,
  serializeResponse,
} from "./capnweb.ts";
import type { Kv } from "./kv.ts";
import type { CreateS2sWebSocket } from "./s2s.ts";
import type { AgentDef } from "./types.ts";
import type { VectorEntry, VectorStore } from "./vector.ts";
import { createWintercServer, type WintercServer } from "./winterc_server.ts";

// ─── Zod schemas for RPC results ────────────────────────────────────────────

const FetchResultSchema = z.object({
  status: z.number(),
  headers: z.record(z.string(), z.string()),
  body: z.string(),
});

const WorkerInitArgsSchema = z.tuple([z.record(z.string(), z.string())]);

const WorkerFetchArgsSchema = z.tuple([
  z.string(),
  z.string(),
  z.record(z.string(), z.string()),
  z.string().optional(),
]);

const WorkerWsArgsSchema = z.tuple([z.boolean().optional()]);

declare const self: {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent) => void) | null;
};

/**
 * Initialize a sandboxed worker with the given agent definition.
 *
 * Sets up capnweb RPC, monkeypatches fetch, creates capability stubs,
 * and waits for the host to send initialization data before creating
 * the WinterTC server.
 */
export function initWorker(agent: AgentDef): void {
  const endpoint = new CapnwebEndpoint(self as CapnwebPort);

  // ─── Monkeypatch fetch to proxy through host ────────────────────────────
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let url: string;
    let method = "GET";
    let headers: Record<string, string> = {};
    let body: string | undefined;

    if (typeof input === "string") {
      url = input;
    } else if (input instanceof URL) {
      url = input.toString();
    } else {
      url = input.url;
      method = input.method;
      headers = Object.fromEntries(input.headers);
      if (input.body) {
        body = await new Response(input.body).text();
      }
    }

    if (init?.method) method = init.method;
    if (init?.headers) {
      headers = Object.fromEntries(new Headers(init.headers as HeadersInit));
    }
    if (init?.body !== undefined) {
      body = typeof init.body === "string" ? init.body : String(init.body);
    }

    const raw = await endpoint.call("host.fetch", [url, method, headers, body]);
    return deserializeResponse(FetchResultSchema.parse(raw) as SerializedResponse);
  };

  // ─── Capnweb-backed KV ─────────────────────────────────────────────────
  const kv: Kv = {
    async get<T = unknown>(key: string): Promise<T | null> {
      const raw = await endpoint.call("kv.get", [key]);
      if (raw === null || raw === undefined) return null;
      return raw as T;
    },
    async set(key: string, value: unknown, options?: { expireIn?: number }): Promise<void> {
      await endpoint.call("kv.set", [key, value, options?.expireIn]);
    },
    async delete(key: string): Promise<void> {
      await endpoint.call("kv.del", [key]);
    },
    async list<T = unknown>(
      prefix: string,
      options?: { limit?: number; reverse?: boolean },
    ): Promise<{ key: string; value: T }[]> {
      return (await endpoint.call("kv.list", [prefix, options?.limit, options?.reverse])) as {
        key: string;
        value: T;
      }[];
    },
  };

  // ─── Capnweb-backed vector store ───────────────────────────────────────
  const vector: VectorStore = {
    async upsert(id: string, data: string, metadata?: Record<string, unknown>): Promise<void> {
      await endpoint.call("vec.upsert", [id, data, metadata]);
    },
    async query(
      text: string,
      options?: { topK?: number; filter?: string },
    ): Promise<VectorEntry[]> {
      return (await endpoint.call("vec.query", [
        text,
        options?.topK,
        options?.filter,
      ])) as VectorEntry[];
    },
    async remove(ids: string | string[]): Promise<void> {
      const idArray = Array.isArray(ids) ? ids : [ids];
      await endpoint.call("vec.remove", [idArray]);
    },
  };

  const vectorSearch = async (query: string, topK: number): Promise<string> => {
    const results = await vector.query(query, { topK });
    if (results.length === 0) return "No relevant results found.";
    return JSON.stringify(
      results.map((r) => ({ score: r.score, text: r.data, metadata: r.metadata })),
    );
  };

  // ─── Capnweb-backed S2S WebSocket factory ──────────────────────────────
  const createWebSocket: CreateS2sWebSocket = (url, opts) => {
    const { port1, port2 } = new MessageChannel();
    endpoint.notify("host.createWebSocket", [url, JSON.stringify(opts.headers)], [port2]);
    return new BridgedWebSocket(port1);
  };

  // ─── RPC handlers ──────────────────────────────────────────────────────

  let wintercServer: WintercServer | null = null;

  // Handle init from host — creates the WinterTC server
  endpoint.handle("worker.init", (args) => {
    const [env] = WorkerInitArgsSchema.parse(args);

    wintercServer = createWintercServer({
      agent,
      env,
      kv,
      vector,
      vectorSearch,
      createWebSocket,
    });

    return "ok";
  });

  // Handle HTTP request forwarding
  endpoint.handle("worker.fetch", async (args) => {
    if (!wintercServer) throw new Error("Worker not initialized");
    const [url, method, headers, body] = WorkerFetchArgsSchema.parse(args);

    const request = new Request(url, {
      method,
      headers,
      ...(body ? { body } : {}),
    });

    return await serializeResponse(await wintercServer.fetch(request));
  });

  // Handle new WebSocket client connection — port transferred from host
  endpoint.handle("worker.handleWebSocket", (_args, ports) => {
    if (!wintercServer) throw new Error("Worker not initialized");
    const [skipGreeting] = WorkerWsArgsSchema.parse(_args);
    const port = ports[0];
    if (!port) throw new Error("No port transferred");

    const ws = new BridgedWebSocket(port);
    wintercServer.handleWebSocket(ws, { skipGreeting: skipGreeting ?? false });
    return "ok";
  });
}
