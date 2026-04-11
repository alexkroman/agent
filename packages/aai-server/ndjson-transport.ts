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
import { z } from "zod";

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

// ── JSON-RPC envelope schemas ───────────────────────────────────────────────

const JsonRpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.number(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.number(),
  method: z.string(),
  params: z.unknown().optional(),
});

const JsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string(),
  params: z.unknown().optional(),
});

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

// ── Message parsing ─────────────────────────────────────────────────────────

type ParsedMessage =
  | { kind: "response"; data: JsonRpcResponse }
  | { kind: "request"; data: JsonRpcRequest }
  | { kind: "notification"; data: JsonRpcNotification }
  | null;

function parseJsonRpcMessage(line: string): ParsedMessage {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;

  const obj = raw as Record<string, unknown>;
  if ("result" in obj || "error" in obj) {
    const parsed = JsonRpcResponseSchema.safeParse(obj);
    return parsed.success ? { kind: "response", data: parsed.data as JsonRpcResponse } : null;
  }
  if ("id" in obj && "method" in obj) {
    const parsed = JsonRpcRequestSchema.safeParse(obj);
    return parsed.success ? { kind: "request", data: parsed.data as JsonRpcRequest } : null;
  }
  if ("method" in obj) {
    const parsed = JsonRpcNotificationSchema.safeParse(obj);
    return parsed.success
      ? { kind: "notification", data: parsed.data as JsonRpcNotification }
      : null;
  }
  return null;
}

// ── Implementation ───────────────────────────────────────────────────────────

export function createNdjsonConnection(readable: Readable, writable: Writable): NdjsonConnection {
  let nextId = 1;
  let disposed = false;
  let rl: ReturnType<typeof createInterface> | null = null;

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
    const msg = parseJsonRpcMessage(line);
    if (!msg) return;

    switch (msg.kind) {
      case "response":
        handleResponse(msg.data);
        break;
      case "request":
        void handleIncomingRequest(msg.data);
        break;
      case "notification":
        notificationHandlers.get(msg.data.method)?.(msg.data.params);
        break;
      default:
        break;
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
      if (disposed) return;
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
      rl = createInterface({ input: readable, crlfDelay: Number.POSITIVE_INFINITY });
      rl.on("line", (line) => {
        handleLine(line);
      });
      rl.on("close", () => {
        if (!disposed) {
          disposed = true;
          const err = new Error("Connection closed");
          for (const pend of pending.values()) {
            pend.reject(err);
          }
          pending.clear();
        }
      });
    },

    dispose(): void {
      disposed = true;
      const err = new Error("Connection disposed");
      for (const pend of pending.values()) {
        pend.reject(err);
      }
      pending.clear();
      rl?.close();
    },
  };
}
