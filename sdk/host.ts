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
  CapnwebEndpoint,
  type CapnwebPort,
  deserializeResponse,
  type SerializedRequest,
  type SerializedResponse,
  serializeRequest,
} from "./capnweb.ts";

// ─── Audio validation (applied at the host transport layer) ─────────────────

/** Max size for a single audio chunk from the browser (1 MB). */
const MAX_AUDIO_CHUNK_BYTES = 1_048_576;

/** Validate a PCM16 audio chunk: non-empty, within size bounds, even byte length. */
function isValidAudioChunk(data: ArrayBuffer): boolean {
  return (
    data.byteLength > 0 && data.byteLength <= MAX_AUDIO_CHUNK_BYTES && data.byteLength % 2 === 0
  );
}

import type { VectorEntry } from "./vector.ts";

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
 * Execute an HTTP fetch from a serialized request.
 *
 * Default implementation for the `host.fetch` RPC — performs the fetch
 * and returns a serialized response. Servers can wrap this to add SSRF
 * checks or other guards.
 */
export async function defaultHostFetch(req: SerializedRequest): Promise<SerializedResponse> {
  const [url, method, headers, body] = req;
  const response = await fetch(url, {
    method,
    headers,
    ...(body ? { body } : {}),
  });
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: await response.text(),
  };
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
   * Fetch handler. Receives a serialized request, returns a serialized
   * response. Use {@linkcode defaultHostFetch} as the base and wrap it
   * to add SSRF checks or other guards.
   */
  fetch(req: SerializedRequest): Promise<SerializedResponse>;
  /** Called when the worker requests an S2S WebSocket connection. */
  createWebSocket(url: string, headers: Record<string, string>, port: MessagePort): void;
};

/** A host-side sandbox created by {@linkcode createHostEndpoint}. */
export type HostSandbox = {
  /** The underlying RPC endpoint (for advanced use). */
  endpoint: CapnwebEndpoint;
  /** Bridge a WebSocket to a new worker session. */
  startSession(socket: BridgeableWebSocket, skipGreeting?: boolean): void;
  /** Forward an HTTP request to the worker. */
  fetch(request: Request): Promise<Response>;
};

/**
 * Create a host endpoint for a sandboxed worker.
 *
 * Registers all standard RPC handlers (`host.fetch`, `host.kv`,
 * `host.vector`, `host.createWebSocket`), calls `worker.init`, and
 * returns a {@linkcode HostSandbox} with `startSession` and `fetch`.
 */
export async function createHostEndpoint(
  port: CapnwebPort,
  opts: HostEndpointOptions,
): Promise<HostSandbox> {
  const endpoint = new CapnwebEndpoint(port);

  // Register host-side RPC handlers
  endpoint.handle("host.fetch", (args) => opts.fetch(args as SerializedRequest));

  // KV — flat per-method handlers
  const { kv } = opts;
  endpoint.handle("kv.get", (args) => kv.get(args[0] as string));
  endpoint.handle("kv.set", async (args) => {
    const [key, value, expireIn] = args as [string, unknown, number | undefined];
    await kv.set(key, value, expireIn);
    return null;
  });
  endpoint.handle("kv.del", async (args) => {
    await kv.del(args[0] as string);
    return null;
  });
  endpoint.handle("kv.list", (args) => {
    const [prefix, limit, reverse] = args as [string, number | undefined, boolean | undefined];
    return kv.list(prefix, limit, reverse);
  });
  endpoint.handle("kv.keys", (args) => {
    if (!kv.keys) throw new Error("keys op not supported");
    return kv.keys(args[0] as string | undefined);
  });

  // Vector — flat per-method handlers
  const noVec = () => {
    throw new Error("Vector store not configured");
  };
  const vec = opts.vector;
  endpoint.handle(
    "vec.upsert",
    vec
      ? async (args) => {
          await vec.upsert(
            args[0] as string,
            args[1] as string,
            args[2] as Record<string, unknown> | undefined,
          );
          return null;
        }
      : noVec,
  );
  endpoint.handle(
    "vec.query",
    vec
      ? (args) =>
          vec.query(args[0] as string, args[1] as number | undefined, args[2] as string | undefined)
      : noVec,
  );
  endpoint.handle(
    "vec.remove",
    vec
      ? async (args) => {
          await vec.remove(args[0] as string[]);
          return null;
        }
      : noVec,
  );

  endpoint.handle("host.createWebSocket", (_args, ports) => {
    const [url, headersJson] = _args as [string, string];
    const headers = JSON.parse(headersJson) as Record<string, string>;
    const port = ports[0];
    if (!port) throw new Error("No port transferred for WebSocket");
    opts.createWebSocket(url, headers, port);
    return null;
  });

  // Initialize the worker
  await endpoint.call("worker.init", [opts.env]);

  return {
    endpoint,

    startSession(socket: BridgeableWebSocket, skipGreeting?: boolean): void {
      const { port1, port2 } = new MessageChannel();
      bridgeWebSocketToPort(socket, port1, {
        filterBinary: isValidAudioChunk,
      });
      endpoint.notify("worker.handleWebSocket", [skipGreeting ?? false], [port2]);
    },

    async fetch(request: Request): Promise<Response> {
      const result = (await endpoint.call(
        "worker.fetch",
        await serializeRequest(request),
      )) as SerializedResponse;
      return deserializeResponse(result);
    },
  };
}
