// Copyright 2025 the AAI authors. MIT license.
//
// Host RPC layer for the Node guest harness.
//
// Owns the outbound message path (JSON-RPC frames over the host's control
// WebSocket), the host request/response proxy (db/query — platform Postgres
// credentials never enter tenant containers), and the db adapter handed to
// tool contexts and the runtime. Split out of `harness.ts`, which keeps the
// dispatch loop and the embedded runtime.

import type { JsonRpcMessage } from "./harness-types.ts";

// ---- Outbound message path ----------------------------------------------------

/**
 * The send function for the currently connected host WebSocket, installed by
 * the harness when the host's connection is accepted and cleared when it
 * closes. Messages sent with no host connected are dropped — the connection
 * IS host liveness, so there is nobody to receive them.
 */
let hostSend: ((msg: JsonRpcMessage) => void) | null = null;

export function setHostSend(send: ((msg: JsonRpcMessage) => void) | null): void {
  hostSend = send;
}

/** Serialize and send one JSON-RPC frame to the host (no-op when detached). */
export function writeMessage(msg: JsonRpcMessage): void {
  hostSend?.(msg);
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
 * Timeout for a guest→host request — mirrors the host side's
 * DEFAULT_REQUEST_TIMEOUT_MS (rpc-transport.ts). A host that never replies
 * (crashed mid-RPC) must not leave a tool call awaiting a db response
 * forever.
 */
const HOST_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Pending host responses, keyed by request id.
 * The dispatch loop resolves these when the host replies.
 */
export const pendingHostRequests = new Map<
  number | string,
  { resolve: (value: unknown) => void; reject: (err: unknown) => void }
>();

/**
 * Send an RPC request to the host and wait for its response. Exported for
 * the studio session (guest→host `studio/sync-workspace`,
 * `studio/persist-chat`); `timeoutMs` exists because a workspace build
 * legitimately outlives the default deadline.
 */
export function hostRequest(
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number = HOST_REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  const id = hostRequestId++;
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const timer = setTimeout(() => {
    if (pendingHostRequests.delete(id)) {
      reject(new Error(`Host RPC "${method}" timed out after ${timeoutMs}ms`));
    }
  }, timeoutMs);
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
  writeMessage({ jsonrpc: "2.0", id, method, params });
  return promise;
}

/**
 * Reject every pending host request. Called by the harness when the host's
 * WebSocket closes — nothing pending can ever be answered. Rejecting also
 * clears each request's timeout timer.
 */
export function rejectAllPendingHostRequests(reason: string): void {
  const err = new Error(reason);
  for (const entry of pendingHostRequests.values()) {
    entry.reject(err);
  }
  pendingHostRequests.clear();
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
