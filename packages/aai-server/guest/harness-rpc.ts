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
  GenerateAdapter,
  GenerateResult,
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

// Writes are serialized through a promise chain so NDJSON framing and
// ordering are preserved without blocking the event loop. The old
// `Deno.stdout.writeSync` loop stalled the guest's ENTIRE event loop (every
// concurrent tool in the sandbox) whenever a line outran the ~64 KB pipe
// buffer while the host was busy.
let writeQueue: Promise<void> = Promise.resolve();

/**
 * Set once the host has closed our stdout pipe (BrokenPipe). Further writes
 * are dropped: retrying would throw again — including from error paths like
 * sendError inside dispatchMessage's catch — making guest teardown noisy.
 */
let stdoutDead = false;

/**
 * Queue one NDJSON line for stdout. Serialization happens synchronously at
 * call time, so later mutation of `msg` cannot affect what is written. The
 * returned promise settles when the line is fully flushed; it never
 * rejects — a failed write marks the pipe dead (stdout is the harness's
 * only channel to the host, so a write error means the host is gone), is
 * logged to stderr once, and all further writes are dropped so teardown
 * stays clean.
 */
export function writeMessage(msg: JsonRpcMessage): Promise<void> {
  if (stdoutDead) return Promise.resolve();
  const bytes = encoder.encode(`${JSON.stringify(msg)}\n`);
  writeQueue = writeQueue
    .then(async () => {
      if (stdoutDead) return;
      // write may accept fewer bytes than requested (pipe buffer full) —
      // loop until the whole line is flushed so framing never tears.
      let written = 0;
      while (written < bytes.byteLength) {
        written += await Deno.stdout.write(bytes.subarray(written));
      }
    })
    .catch((err: unknown) => {
      stdoutDead = true;
      console.error(`harness stdout write failed: ${errMsg(err)}`);
    });
  return writeQueue;
}

export function sendResponse(id: number | string, result: unknown): Promise<void> {
  return writeMessage({ jsonrpc: "2.0", id, result });
}

export function sendError(id: number | string, code: number, message: string): Promise<void> {
  return writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

// ---- Host RPC proxy ---------------------------------------------------------

let hostRequestId = 1;

/**
 * Timeout for a guest→host request — mirrors the host side's
 * DEFAULT_REQUEST_TIMEOUT_MS (ndjson-transport.ts). A host that never
 * replies (crashed mid-RPC, pipe wedged) must not leave a tool call awaiting
 * a KV/Vector response forever.
 */
const HOST_REQUEST_TIMEOUT_MS = 30_000;

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
  const timer = setTimeout(() => {
    if (pendingHostRequests.delete(id)) {
      reject(new Error(`Host RPC "${method}" timed out after ${HOST_REQUEST_TIMEOUT_MS}ms`));
    }
  }, HOST_REQUEST_TIMEOUT_MS);
  pendingHostRequests.set(id, {
    resolve: (value) => {
      clearTimeout(timer);
      resolve(value);
    },
    reject: (err) => {
      clearTimeout(timer);
      reject(err);
    },
  });
  // Fire-and-forget: the write chain preserves ordering and marks the pipe
  // dead on failure; the response (or the timeout) is what settles `promise`.
  void writeMessage({ jsonrpc: "2.0", id, method, params });
  return promise;
}

/**
 * Reject every pending host request and proxied fetch. Called by the main
 * loop when stdin closes — the host is gone, so nothing pending can ever be
 * answered (mirrors rejectAllPending on the host's NDJSON connection).
 * Rejecting also clears each request's timeout timer, letting Deno exit.
 */
export function rejectAllPendingHostRequests(reason: string): void {
  const err = new Error(reason);
  for (const entry of pendingHostRequests.values()) {
    entry.reject(err);
  }
  pendingHostRequests.clear();
  for (const fetchEntry of pendingFetches.values()) {
    fetchEntry.reject(new TypeError(`fetch failed: ${reason}`));
  }
  pendingFetches.clear();
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

export function sendToClient(sessionId: string, event: string, data: unknown): Promise<void> {
  return writeMessage({
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

/**
 * Generate adapter handed to tool contexts — proxies `ctx.generate` to the
 * host's llm/generate handler. `schema` must already be plain JSON Schema
 * (the SDK's workflow helpers convert Zod schemas caller-side); a Zod schema
 * cannot cross the NDJSON boundary, so it is rejected here with the same
 * guidance the host gives.
 */
export const generateAdapter: GenerateAdapter = async (options) => {
  if (typeof (options.schema as { safeParse?: unknown } | undefined)?.safeParse === "function") {
    throw new Error(
      "generate: `schema` must be a plain JSON Schema object, not a Zod schema — " +
        "convert with z.toJSONSchema(), or use the @alexkroman1/aai/workflow helpers.",
    );
  }
  return (await hostRequest("llm/generate", { ...options })) as GenerateResult;
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
