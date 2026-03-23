// Copyright 2025 the AAI authors. MIT license.
/**
 * Host-side helpers for managing sandboxed workers.
 *
 * Provides `createHostEndpoint` factory that registers all standard
 * host→worker RPC methods for server implementations.
 *
 * @module
 */

import {
  type BridgeableWebSocket,
  bridgeWebSocketToPort,
  createRpcSession,
  isTransferMessage,
  RpcTarget,
  sendTransfer,
  type WorkerPort,
} from "./capnweb.ts";
import type { VectorEntry } from "./vector.ts";

// ─── Audio validation (applied at the host transport layer) ─────────────────

/** Max size for a single audio chunk from the browser (1 MB). */
const MAX_AUDIO_CHUNK_BYTES = 1_048_576;

/** Validate a PCM16 audio chunk: non-empty, within size bounds, even byte length. */
function isValidAudioChunk(data: ArrayBuffer): boolean {
  return (
    data.byteLength > 0 && data.byteLength <= MAX_AUDIO_CHUNK_BYTES && data.byteLength % 2 === 0
  );
}

// ─── Host-side operation interfaces ─────────────────────────────────────────

/** KV operations the host provides to sandboxed workers. */
export type HostKvOps = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, expireIn?: number): Promise<void>;
  del(key: string): Promise<void>;
  list(
    prefix: string,
    limit?: number,
    reverse?: boolean,
  ): Promise<{ key: string; value: unknown }[]>;
  keys?(pattern?: string): Promise<string[]>;
};

/** Vector operations the host provides to sandboxed workers. */
export type HostVectorOps = {
  upsert(id: string, data: string, metadata?: Record<string, unknown>): Promise<void>;
  query(text: string, topK?: number, filter?: string): Promise<VectorEntry[]>;
  remove(ids: string[]): Promise<void>;
};

/**
 * Execute an HTTP fetch on behalf of the sandboxed worker.
 *
 * Default implementation for the host fetch RPC — performs the fetch
 * and returns a serialized response. Servers can wrap this to add SSRF
 * checks or other guards.
 */
export async function defaultHostFetch(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const response = await fetch(new Request(url, { method, headers, ...(body ? { body } : {}) }));
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: await response.text(),
  };
}

// ─── Host RPC service ────────────────────────────────────────────────────────

/** Serialized fetch response for RPC transport. */
export type FetchResult = { status: number; headers: Record<string, string>; body: string };

/**
 * RPC service exposed by the host to the sandboxed worker.
 * Methods are callable via capnweb RPC stubs.
 */
class HostService extends RpcTarget {
  #kv: HostKvOps;
  #vec: HostVectorOps | undefined;
  #fetchFn: (
    url: string,
    method: string,
    headers: Record<string, string>,
    body?: string,
  ) => Promise<FetchResult>;

  constructor(
    kv: HostKvOps,
    vec: HostVectorOps | undefined,
    fetchFn: (
      url: string,
      method: string,
      headers: Record<string, string>,
      body?: string,
    ) => Promise<FetchResult>,
  ) {
    super();
    this.#kv = kv;
    this.#vec = vec;
    this.#fetchFn = fetchFn;
  }

  // ─── Fetch ──────────────────────────────────────────────────────────────
  hostFetch(
    url: string,
    method: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<FetchResult> {
    return this.#fetchFn(url, method, headers, body);
  }

  // ─── KV ─────────────────────────────────────────────────────────────────
  kvGet(key: string): Promise<unknown> {
    return this.#kv.get(key);
  }

  async kvSet(key: string, value: unknown, expireIn?: number): Promise<null> {
    await this.#kv.set(key, value, expireIn);
    return null;
  }

  async kvDel(key: string): Promise<null> {
    await this.#kv.del(key);
    return null;
  }

  kvList(
    prefix: string,
    limit?: number,
    reverse?: boolean,
  ): Promise<{ key: string; value: unknown }[]> {
    return this.#kv.list(prefix, limit, reverse);
  }

  kvKeys(pattern?: string): Promise<string[]> {
    if (!this.#kv.keys) throw new Error("keys op not supported");
    return this.#kv.keys(pattern);
  }

  // ─── Vector ─────────────────────────────────────────────────────────────
  async vecUpsert(id: string, data: string, metadata?: Record<string, unknown>): Promise<null> {
    if (!this.#vec) throw new Error("Vector store not configured");
    await this.#vec.upsert(id, data, metadata);
    return null;
  }

  async vecQuery(text: string, topK?: number, filter?: string): Promise<VectorEntry[]> {
    if (!this.#vec) throw new Error("Vector store not configured");
    return this.#vec.query(text, topK, filter);
  }

  async vecRemove(ids: string[]): Promise<null> {
    if (!this.#vec) throw new Error("Vector store not configured");
    await this.#vec.remove(ids);
    return null;
  }
}

// ─── Host endpoint factory ──────────────────────────────────────────────────

/** Options for {@linkcode createHostEndpoint}. */
export type HostEndpointOptions = {
  /** Environment variables passed to the worker on init. */
  env: Record<string, string>;
  /** KV store operations. */
  kv: HostKvOps;
  /** Vector store operations. Omit if not configured. */
  vector?: HostVectorOps | undefined;
  /**
   * Fetch handler. Receives request components, returns serialized response.
   * Use {@linkcode defaultHostFetch} as the base and wrap it to add SSRF
   * checks or other guards.
   */
  fetch(
    url: string,
    method: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<FetchResult>;
  /** Called when the worker requests an S2S WebSocket connection. */
  createWebSocket(url: string, headers: Record<string, string>, port: MessagePort): void;
};

/** A host-side sandbox created by {@linkcode createHostEndpoint}. */
export type HostSandbox = {
  /** Bridge a WebSocket to a new worker session. */
  startSession(socket: BridgeableWebSocket, skipGreeting?: boolean): void;
  /** Forward an HTTP request to the worker. */
  fetch(request: Request): Promise<Response>;
};

/**
 * Create a host endpoint for a sandboxed worker.
 *
 * Sets up capnweb RPC with a {@linkcode HostService}, initializes the worker,
 * and returns a {@linkcode HostSandbox} with `startSession` and `fetch`.
 */
export async function createHostEndpoint(
  port: WorkerPort,
  opts: HostEndpointOptions,
): Promise<HostSandbox> {
  const hostService = new HostService(opts.kv, opts.vector, opts.fetch);

  const workerStub = createRpcSession({
    port,
    localMain: hostService,
    onTransfer(data, ports) {
      if (!isTransferMessage(data)) return;
      if (data._t === "createWs") {
        const transferPort = ports[0];
        if (!transferPort) throw new Error("No port transferred for WebSocket");
        const headers = JSON.parse(data.headers) as Record<string, string>;
        opts.createWebSocket(data.url, headers, transferPort);
      }
    },
  });

  // Initialize the worker
  await workerStub.init(opts.env);

  return {
    startSession(socket: BridgeableWebSocket, skipGreeting?: boolean): void {
      const { port1, port2 } = new MessageChannel();
      bridgeWebSocketToPort(socket, port1, {
        filterBinary: isValidAudioChunk,
      });
      sendTransfer(port, { _t: "handleWs", skipGreeting: skipGreeting ?? false }, [port2]);
    },

    async fetch(request: Request): Promise<Response> {
      const body = request.body ? await request.text() : undefined;
      const result = await workerStub.workerFetch(
        request.url,
        request.method,
        Object.fromEntries(request.headers),
        body,
      );
      return new Response(result.body, {
        status: result.status,
        headers: result.headers,
      });
    },
  };
}
