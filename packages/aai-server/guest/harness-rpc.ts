// Copyright 2025 the AAI authors. MIT license.
//
// Host RPC + I/O layer for the Deno guest harness.
//
// Owns NDJSON stdout writing, the host request/response proxy (kv/*,
// vector/*), the proxied `fetch` implementation, and the KV/Vector adapters
// handed to tool contexts. Split out of `deno-harness.ts`, which keeps the
// dispatch loop and tool execution. ZERO workspace imports — bundled into the
// self-contained guest artifact.

import type {
  JsonRpcMessage,
  JsonRpcNotification,
  KvAdapter,
  KvInterface,
  VectorAdapter,
  VectorMatch,
} from "./harness-types.ts";

// ---- NDJSON I/O -------------------------------------------------------------

const encoder = new TextEncoder();

export function writeMessage(msg: JsonRpcMessage): void {
  const line = `${JSON.stringify(msg)}\n`;
  Deno.stdout.writeSync(encoder.encode(line));
}

export function sendResponse(id: number | string, result: unknown): void {
  writeMessage({ jsonrpc: "2.0", id, result });
}

export function sendError(id: number | string, code: number, message: string): void {
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

// ---- Host RPC proxy ---------------------------------------------------------

let hostRequestId = 1;

/**
 * Pending host responses, keyed by request id.
 * The main NDJSON loop resolves these when the host replies.
 */
export const pendingHostRequests = new Map<
  number | string,
  { resolve: (value: unknown) => void; reject: (err: unknown) => void }
>();

/** Send an RPC request to the host and wait for its response. */
export function hostRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
  const id = hostRequestId++;
  return new Promise((resolve, reject) => {
    pendingHostRequests.set(id, { resolve, reject });
    writeMessage({ jsonrpc: "2.0", id, method, params });
  });
}

// Old name kept for backward-compat with existing tests
export const pendingKvRequests = pendingHostRequests;

const kv: KvInterface = {
  async get(key: string): Promise<unknown> {
    const resp = (await hostRequest("kv/get", { key })) as { value?: unknown };
    return resp?.value ?? null;
  },
  async set(key: string, value: unknown, opts?: { expireIn?: number }): Promise<void> {
    await hostRequest("kv/set", {
      key,
      value,
      ...(opts?.expireIn !== undefined ? { expireIn: opts.expireIn } : {}),
    });
  },
  async del(key: string): Promise<void> {
    await hostRequest("kv/del", { key });
  },
};

// ---- Fetch proxy ---------------------------------------------------------------

type PendingFetch = {
  resolve: (response: Response) => void;
  reject: (err: Error) => void;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  chunks: Uint8Array[];
};

const pendingFetches = new Map<string, PendingFetch>();

const MAX_REQUEST_BODY_BYTES = 1024 * 1024; // 1 MB

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  // Chunked to avoid one intermediate string per byte (bodies can be up to
  // MAX_REQUEST_BODY_BYTES) while staying under the argument-count limit.
  const CHUNK = 8192;
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function handleFetchNotification(method: string, params: unknown): void {
  const p = params as { id: string; [key: string]: unknown };
  const pending = pendingFetches.get(p.id);
  if (!pending) return;

  switch (method) {
    case "fetch/response-start":
      pending.status = p.status as number;
      pending.statusText = p.statusText as string;
      pending.headers = p.headers as Record<string, string>;
      break;

    case "fetch/response-chunk":
      pending.chunks.push(base64ToBytes(p.data as string));
      break;

    case "fetch/response-end": {
      pendingFetches.delete(p.id);
      const totalLen = pending.chunks.reduce((sum, c) => sum + c.byteLength, 0);
      const body = new Uint8Array(totalLen);
      let offset = 0;
      for (const chunk of pending.chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      pending.resolve(
        new Response(body.length > 0 ? body : null, {
          status: pending.status ?? 200,
          statusText: pending.statusText ?? "",
          headers: pending.headers ?? {},
        }),
      );
      break;
    }

    case "fetch/response-error":
      pendingFetches.delete(p.id);
      pending.reject(new TypeError(`fetch failed: ${p.message}`));
      break;

    default:
      break;
  }
}

globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const req = new Request(input, init);

  let bodyB64: string | null = null;
  if (req.body) {
    const buf = await req.arrayBuffer();
    if (buf.byteLength > MAX_REQUEST_BODY_BYTES) {
      throw new TypeError(`Request body exceeds ${MAX_REQUEST_BODY_BYTES} byte limit`);
    }
    bodyB64 = bytesToBase64(new Uint8Array(buf));
  }

  // Send fetch/request RPC — host returns { id }
  const rpcResponse = (await hostRequest("fetch/request", {
    url: req.url,
    method: req.method,
    headers: Object.fromEntries(req.headers),
    body: bodyB64,
  })) as { id: string };

  // Register a pending fetch and wait for response notifications
  return new Promise<Response>((resolve, reject) => {
    pendingFetches.set(rpcResponse.id, { resolve, reject, chunks: [] });
  });
};

// ---- Client send --------------------------------------------------------------

export function sendToClient(sessionId: string, event: string, data: unknown): void {
  writeMessage({
    jsonrpc: "2.0",
    method: "client/send",
    params: { sessionId, event, data },
  } as JsonRpcNotification);
}

// Adapt KvInterface to the Kv shape expected by ToolContext
export function makeKvAdapter(): KvAdapter {
  return {
    get: <T = unknown>(key: string) => kv.get(key) as Promise<T | null>,
    set: (key: string, value: unknown, options?: { expireIn?: number }) =>
      kv.set(key, value, options),
    delete: (key: string | string[]): Promise<void> => {
      if (Array.isArray(key)) {
        return Promise.all(key.map((k) => kv.del(k))).then(() => undefined);
      }
      return kv.del(key);
    },
  };
}

export function makeVectorAdapter(): VectorAdapter {
  return {
    upsert: (id, text, metadata) =>
      hostRequest("vector/upsert", {
        id,
        text,
        ...(metadata !== undefined ? { metadata } : {}),
      }) as Promise<void>,
    query: async (text, opts) => {
      const result = (await hostRequest("vector/query", {
        text,
        ...(opts?.topK !== undefined ? { topK: opts.topK } : {}),
        ...(opts?.filter !== undefined ? { filter: opts.filter } : {}),
      })) as VectorMatch[];
      return result;
    },
    delete: (ids) => hostRequest("vector/delete", { ids }) as Promise<void>,
  };
}

// ---- Host response dispatch -------------------------------------------------

/** Dispatch an incoming response to a pending host request. */
export function handleHostResponse(resp: {
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}): void {
  const pending = pendingHostRequests.get(resp.id);
  if (!pending) return;
  pendingHostRequests.delete(resp.id);
  if (resp.error) {
    pending.reject(new Error(resp.error.message));
  } else {
    pending.resolve(resp.result);
  }
}

// Old name kept for backward-compat with existing tests
export const handleKvResponse = handleHostResponse;
