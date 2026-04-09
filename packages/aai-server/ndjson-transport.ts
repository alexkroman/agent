// Copyright 2025 the AAI authors. MIT license.
/**
 * NDJSON transport for host↔guest communication.
 *
 * Replaces vscode-jsonrpc with a zero-dependency implementation using
 * node:readline for line splitting. Follows JSON-RPC 2.0 wire format.
 *
 * Interface matches vscode-jsonrpc's MessageConnection shape so callers
 * can swap with minimal changes:
 *   sendRequest, onRequest, sendNotification, onNotification, listen, dispose
 */

import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

// ── Types ────────────────────────────────────────────────────────────────────

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
};

type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

export interface NdjsonConnection {
  sendRequest<T = unknown>(method: string, params?: unknown): Promise<T>;
  sendNotification(method: string, params?: unknown): void;
  onRequest<T = unknown>(method: string, handler: (params: T) => unknown | Promise<unknown>): void;
  onNotification(method: string, handler: (params?: unknown) => void): void;
  listen(): void;
  dispose(): void;
}

// ── Implementation ───────────────────────────────────────────────────────────

export function createNdjsonConnection(readable: Readable, writable: Writable): NdjsonConnection {
  let nextId = 1;
  let disposed = false;

  const pending = new Map<number, PendingRequest>();
  const requestHandlers = new Map<string, (params: unknown) => unknown | Promise<unknown>>();
  const notificationHandlers = new Map<string, (params?: unknown) => void>();

  function send(msg: unknown): void {
    writable.write(`${JSON.stringify(msg)}\n`);
  }

  function handleResponse(response: JsonRpcResponse): void {
    const pend = pending.get(response.id);
    if (!pend) return;
    pending.delete(response.id);

    if (response.error) {
      const err = Object.assign(new Error(response.error.message), {
        code: response.error.code,
      } satisfies { code: number });
      pend.reject(err);
    } else {
      pend.resolve(response.result);
    }
  }

  async function handleIncomingRequest(req: JsonRpcRequest): Promise<void> {
    const handler = requestHandlers.get(req.method);
    if (!handler) {
      send({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32_601, message: `Method not found: ${req.method}` },
      });
      return;
    }
    try {
      const result = await handler(req.params);
      send({ jsonrpc: "2.0", id: req.id, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      send({ jsonrpc: "2.0", id: req.id, error: { code: -32_603, message } });
    }
  }

  function handleLine(line: string): void {
    let msg: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;
    try {
      msg = JSON.parse(line) as JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;
    } catch {
      // Ignore malformed lines
      return;
    }

    if ("result" in msg || "error" in msg) {
      handleResponse(msg as JsonRpcResponse);
    } else if ("id" in msg && "method" in msg) {
      void handleIncomingRequest(msg as JsonRpcRequest);
    } else if ("method" in msg) {
      const notif = msg as JsonRpcNotification;
      notificationHandlers.get(notif.method)?.(notif.params);
    }
  }

  return {
    sendRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
      if (disposed) {
        return Promise.reject(new Error("Connection disposed"));
      }
      const id = nextId++;
      const promise = new Promise<T>((resolve, reject) => {
        pending.set(id, {
          resolve: resolve as (v: unknown) => void,
          reject,
        });
      });
      const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method };
      if (params !== undefined) msg.params = params;
      send(msg);
      return promise;
    },

    sendNotification(method: string, params?: unknown): void {
      const msg: JsonRpcNotification = { jsonrpc: "2.0", method };
      if (params !== undefined) msg.params = params;
      send(msg);
    },

    onRequest<T = unknown>(
      method: string,
      handler: (params: T) => unknown | Promise<unknown>,
    ): void {
      requestHandlers.set(method, handler as (params: unknown) => unknown | Promise<unknown>);
    },

    onNotification(method: string, handler: (params?: unknown) => void): void {
      notificationHandlers.set(method, handler);
    },

    listen(): void {
      const rl = createInterface({ input: readable, crlfDelay: Number.POSITIVE_INFINITY });
      rl.on("line", (line) => {
        handleLine(line);
      });
    },

    dispose(): void {
      disposed = true;
      const err = new Error("Connection disposed");
      for (const pend of pending.values()) {
        pend.reject(err);
      }
      pending.clear();
    },
  };
}
