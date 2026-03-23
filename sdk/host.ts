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
import type { Kv, KvListOptions } from "./kv.ts";
import type { VectorStore } from "./vector.ts";

// ─── Audio validation (applied at the host transport layer) ─────────────────

/** Max size for a single audio chunk from the browser (1 MB). */
const MAX_AUDIO_CHUNK_BYTES = 1_048_576;

/** Validate a PCM16 audio chunk: non-empty, within size bounds, even byte length. */
function isValidAudioChunk(data: ArrayBuffer): boolean {
  return (
    data.byteLength > 0 && data.byteLength <= MAX_AUDIO_CHUNK_BYTES && data.byteLength % 2 === 0
  );
}

// ─── Shared types ───────────────────────────────────────────────────────────

/** Serialized fetch response for RPC transport. */
export type FetchResult = { status: number; headers: Record<string, string>; body: string };

/** Fetch function signature for host→worker RPC. */
export type HostFetchFn = (
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
) => Promise<FetchResult>;

/** Kv with optional key-listing support. */
export type KvWithKeys = Kv & { keys?(pattern?: string): Promise<string[]> };

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
): Promise<FetchResult> {
  const response = await fetch(new Request(url, { method, headers, ...(body ? { body } : {}) }));
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: await response.text(),
  };
}

// ─── Host RPC service ────────────────────────────────────────────────────────

/** Convert a void promise to null (capnweb RPC requires a return value). */
async function voidToNull(p: Promise<void>): Promise<null> {
  await p;
  return null;
}

/**
 * RPC service exposed by the host to the sandboxed worker.
 * Methods are callable via capnweb RPC stubs.
 */
class HostService extends RpcTarget {
  #kv: KvWithKeys;
  #vec: VectorStore | undefined;
  #fetchFn: HostFetchFn;

  constructor(kv: KvWithKeys, vec: VectorStore | undefined, fetchFn: HostFetchFn) {
    super();
    this.#kv = kv;
    this.#vec = vec;
    this.#fetchFn = fetchFn;
  }

  hostFetch(url: string, method: string, headers: Record<string, string>, body?: string) {
    return this.#fetchFn(url, method, headers, body);
  }

  kvGet(key: string) {
    return this.#kv.get(key);
  }

  kvSet(key: string, value: unknown, options?: { expireIn?: number }) {
    return voidToNull(this.#kv.set(key, value, options));
  }

  kvDel(key: string) {
    return voidToNull(this.#kv.delete(key));
  }

  kvList(prefix: string, options?: KvListOptions) {
    return this.#kv.list(prefix, options);
  }

  kvKeys(pattern?: string) {
    if (!this.#kv.keys) throw new Error("keys op not supported");
    return this.#kv.keys(pattern);
  }

  #requireVec(): VectorStore {
    if (!this.#vec) throw new Error("Vector store not configured");
    return this.#vec;
  }

  vecUpsert(id: string, data: string, metadata?: Record<string, unknown>) {
    return voidToNull(this.#requireVec().upsert(id, data, metadata));
  }

  vecQuery(text: string, options?: { topK?: number; filter?: string }) {
    return this.#requireVec().query(text, options);
  }

  vecRemove(ids: string[]) {
    return voidToNull(this.#requireVec().remove(ids));
  }
}

// ─── Host endpoint factory ──────────────────────────────────────────────────

/** Options for {@linkcode createHostEndpoint}. */
export type HostEndpointOptions = {
  /** Environment variables passed to the worker on init. */
  env: Record<string, string>;
  /** KV store operations. */
  kv: KvWithKeys;
  /** Vector store operations. Omit if not configured. */
  vector?: VectorStore | undefined;
  /** Fetch handler. Use {@linkcode defaultHostFetch} as the base. */
  fetch: HostFetchFn;
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
