// Copyright 2025 the AAI authors. MIT license.
/**
 * Sandboxed worker entry point for platform mode.
 *
 * Called from the bundled `worker.js` inside a Deno Worker with all
 * permissions false. Sets up capnweb RPC to proxy capabilities through
 * the host, and delegates to a {@linkcode WintercServer} for session
 * management.
 *
 * @module
 */

import {
  BridgedWebSocket,
  createRpcSession,
  isTransferMessage,
  RpcTarget,
  sendTransfer,
  type WorkerPort,
} from "./capnweb.ts";
import type { Kv } from "./kv.ts";
import type { CreateS2sWebSocket } from "./s2s.ts";
import type { AgentDef } from "./types.ts";
import type { VectorEntry, VectorStore } from "./vector.ts";
import { createWintercServer, type WintercServer } from "./winterc_server.ts";

declare const self: WorkerPort;

/**
 * RPC service exposed by the worker to the host.
 * Methods are callable via capnweb RPC stubs.
 */
class WorkerService extends RpcTarget {
  #agent: AgentDef;
  #kv: Kv;
  #vector: VectorStore;
  #vectorSearch: ((query: string, topK: number) => Promise<string>) | undefined;
  #createWebSocket: CreateS2sWebSocket;
  #wintercServer: WintercServer | null = null;

  constructor(
    agent: AgentDef,
    kv: Kv,
    vector: VectorStore,
    vectorSearch: ((query: string, topK: number) => Promise<string>) | undefined,
    createWebSocket: CreateS2sWebSocket,
  ) {
    super();
    this.#agent = agent;
    this.#kv = kv;
    this.#vector = vector;
    this.#vectorSearch = vectorSearch;
    this.#createWebSocket = createWebSocket;
  }

  /** Initialize the worker with environment variables. Creates the WinterTC server. */
  init(env: Record<string, string>): string {
    this.#wintercServer = createWintercServer({
      agent: this.#agent,
      env,
      kv: this.#kv,
      vector: this.#vector,
      vectorSearch: this.#vectorSearch,
      createWebSocket: this.#createWebSocket,
    });
    return "ok";
  }

  /** Handle an HTTP request forwarded from the host. */
  async workerFetch(
    url: string,
    method: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    if (!this.#wintercServer) throw new Error("Worker not initialized");
    const request = new Request(url, { method, headers, ...(body ? { body } : {}) });
    const response = await this.#wintercServer.fetch(request);
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.text(),
    };
  }

  /** Handle a new WebSocket client connection (called via port transfer, not RPC). */
  handleWebSocket(port: MessagePort, skipGreeting: boolean): void {
    if (!this.#wintercServer) throw new Error("Worker not initialized");
    const ws = new BridgedWebSocket(port);
    this.#wintercServer.handleWebSocket(ws, { skipGreeting });
  }
}

/**
 * Initialize a sandboxed worker with the given agent definition.
 *
 * Sets up capnweb RPC, creates capability stubs backed by the host,
 * and waits for initialization before creating the WinterTC server.
 */
export function initWorker(agent: AgentDef): void {
  // biome-ignore lint/suspicious/noExplicitAny: capnweb stubs are dynamically typed proxies
  let hostStub: any;

  // ─── Capnweb-backed KV ─────────────────────────────────────────────────
  const kv: Kv = {
    async get<T = unknown>(key: string): Promise<T | null> {
      const raw = await hostStub.kvGet(key);
      return raw == null ? null : (raw as T);
    },
    async set(key: string, value: unknown, options?: { expireIn?: number }): Promise<void> {
      await hostStub.kvSet(key, value, options);
    },
    async delete(key: string): Promise<void> {
      await hostStub.kvDel(key);
    },
    async list<T = unknown>(
      prefix: string,
      options?: { limit?: number; reverse?: boolean },
    ): Promise<{ key: string; value: T }[]> {
      return (await hostStub.kvList(prefix, options)) as { key: string; value: T }[];
    },
  };

  // ─── Capnweb-backed vector store ───────────────────────────────────────
  const vector: VectorStore = {
    async upsert(id: string, data: string, metadata?: Record<string, unknown>): Promise<void> {
      await hostStub.vecUpsert(id, data, metadata);
    },
    async query(
      text: string,
      options?: { topK?: number; filter?: string },
    ): Promise<VectorEntry[]> {
      return (await hostStub.vecQuery(text, options)) as VectorEntry[];
    },
    async remove(ids: string | string[]): Promise<void> {
      await hostStub.vecRemove(Array.isArray(ids) ? ids : [ids]);
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
    sendTransfer(self, { _t: "createWs", url, headers: JSON.stringify(opts.headers) }, [port2]);
    return new BridgedWebSocket(port1);
  };

  // ─── Monkeypatch fetch to proxy through host ──────────────────────────
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const body = request.body ? await request.text() : undefined;
    const result = await hostStub.hostFetch(
      request.url,
      request.method,
      Object.fromEntries(request.headers),
      body,
    );
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    });
  };

  // ─── Create worker service and RPC session ────────────────────────────
  const workerService = new WorkerService(agent, kv, vector, vectorSearch, createWebSocket);

  hostStub = createRpcSession({
    port: self,
    localMain: workerService,
    onTransfer(data, ports) {
      if (!isTransferMessage(data)) return;
      if (data._t === "handleWs") {
        const transferPort = ports[0];
        if (!transferPort) throw new Error("No port transferred for WebSocket");
        workerService.handleWebSocket(transferPort, data.skipGreeting);
      }
    },
  });
}
