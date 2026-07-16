// Copyright 2025 the AAI authors. MIT license.
//
// Host RPC + I/O layer for the Deno guest harness.
//
// Owns NDJSON stdout writing, the host request/response proxy (kv/*,
// vector/*), the proxied `fetch` implementation, and the KV/Vector adapters
// handed to tool contexts. Split out of `deno-harness.ts`, which keeps the
// dispatch loop and tool execution. ZERO workspace imports — bundled into the
// self-contained guest artifact.

import { Buffer } from "node:buffer";
import type {
  JsonRpcMessage,
  JsonRpcNotification,
  KvAdapter,
  VectorAdapter,
  VectorMatch,
} from "./harness-types.ts";
import { MAX_REQUEST_BODY_BYTES } from "./limits.ts";

// ---- Shared helpers ----------------------------------------------------------

/** Extract an error message from an unknown thrown value. */
export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Race a promise against a wall-clock timeout, clearing the timer in every outcome. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ---- NDJSON I/O -------------------------------------------------------------

const encoder = new TextEncoder();

export function writeMessage(msg: JsonRpcMessage): void {
  const line = `${JSON.stringify(msg)}\n`;
  const bytes = encoder.encode(line);
  // writeSync may write fewer bytes than requested (pipe buffer full) —
  // loop until the whole line is flushed so NDJSON framing never tears.
  let written = 0;
  while (written < bytes.byteLength) {
    written += Deno.stdout.writeSync(bytes.subarray(written));
  }
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
function hostRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
  const id = hostRequestId++;
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  pendingHostRequests.set(id, { resolve, reject });
  writeMessage({ jsonrpc: "2.0", id, method, params });
  return promise;
}

// ---- Fetch proxy ---------------------------------------------------------------

type PendingFetch = {
  resolve: (response: Response) => void;
  reject: (err: Error) => void;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  chunks: Uint8Array[];
};

/**
 * Pending proxied fetches, keyed by guest-generated fetch id.
 * Exported so tests can assert entries never leak.
 */
export const pendingFetches = new Map<string, PendingFetch>();

let nextFetchId = 1;

// The guest-side check is a friendly early error only — the host enforces
// the same cap authoritatively (see sandbox-fetch.ts).

// Native codecs via node:buffer (supported by Deno, no permission flags) —
// the atob/btoa route costs a per-byte JS loop plus transient binary strings
// on the guest's single event loop, where tool code also runs.
function base64ToBytes(b64: string): Uint8Array {
  return Buffer.from(b64, "base64");
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
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

  // The guest generates the id and registers the pending entry BEFORE
  // sending the RPC. Host-side early rejections (disallowed host, oversized
  // body, invalid URL) emit fetch/response-error notifications synchronously;
  // with a host-generated id those could arrive ahead of the `{ id }`
  // response, get dropped, and stall the fetch until the tool timeout.
  const id = `f${nextFetchId++}`;
  const { promise, resolve, reject } = Promise.withResolvers<Response>();
  pendingFetches.set(id, { resolve, reject, chunks: [] });
  hostRequest("fetch/request", {
    id,
    url: req.url,
    method: req.method,
    headers: Object.fromEntries(req.headers),
    body: bodyB64,
  }).catch((err: unknown) => {
    // The RPC itself failed (no fetch handler registered, host rejected the
    // params, connection dropped) — clean up the pending entry so it never
    // leaks, and reject promptly instead of hanging.
    if (pendingFetches.delete(id)) {
      reject(new TypeError(`fetch failed: ${errMsg(err)}`));
    }
  });
  return promise;
};

// ---- Client send --------------------------------------------------------------

export function sendToClient(sessionId: string, event: string, data: unknown): void {
  writeMessage({
    jsonrpc: "2.0",
    method: "client/send",
    params: { sessionId, event, data },
  } as JsonRpcNotification);
}

// The adapters are stateless views over hostRequest, so a single module-level
// instance serves every tool call.
/** Kv adapter handed to tool contexts. */
export const kvAdapter: KvAdapter = {
  // The host's kv/get handler returns the stored value directly as the RPC
  // result (see configureSandbox), not wrapped in { value } — return it as-is.
  get: async <T = unknown>(key: string) =>
    ((await hostRequest("kv/get", { key })) ?? null) as T | null,
  set: async (key: string, value: unknown, options?: { expireIn?: number }) => {
    await hostRequest("kv/set", {
      key,
      value,
      ...(options?.expireIn !== undefined ? { expireIn: options.expireIn } : {}),
    });
  },
  delete: async (keys: string | string[]): Promise<void> => {
    const keyArray = Array.isArray(keys) ? keys : [keys];
    await Promise.all(keyArray.map((key) => hostRequest("kv/del", { key })));
  },
};

/** Vector adapter handed to tool contexts. */
export const vectorAdapter: VectorAdapter = {
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
