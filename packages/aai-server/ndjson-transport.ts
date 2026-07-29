// Copyright 2025 the AAI authors. MIT license.
// NDJSON transport for host↔guest JSON-RPC 2.0 communication.
//
// Line framing (node:readline) and write backpressure are handled here;
// JSON-RPC id allocation, response correlation, per-request timeouts, and
// request dispatch are delegated to the `json-rpc-2.0` library. The wire
// format is unchanged: one JSON object per line with `jsonrpc`/`id`/
// `method`/`params`/`result`/`error` fields, -32601 for unknown methods
// and -32603 for handler failures (the guest harness speaks exactly this).

import { createInterface } from "node:readline";
import { type Readable, Transform, type Writable } from "node:stream";
import { errorMessage } from "@alexkroman1/aai";
import {
  createJSONRPCErrorResponse,
  JSONRPCClient,
  JSONRPCErrorCode,
  JSONRPCServer,
} from "json-rpc-2.0";
import { z } from "zod";

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

/**
 * Default timeout for a host→guest request. A wedged guest (e.g. a bundle
 * whose top level never resolves) must not leave a pending request — and
 * anything awaiting it, like shutdownSandbox holding the slug lock — hanging
 * forever.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Hard cap on one NDJSON line. Without it, a compromised guest can stream
 * gigabytes with no newline and grow the host's readline buffer without
 * bound — a cross-tenant DoS on the shared host process.
 *
 * Sizing: the largest legitimate frames are `bundle/load` requests carrying
 * a whole worker bundle (MAX_WORKER_SIZE, 10 MB, and JSON string escaping
 * can roughly double that in pathological bundles) and proxied-fetch bodies
 * (1 MB, ~1.4 MB as base64). 32 MB clears both with generous headroom while
 * still bounding a hostile stream to a small constant.
 */
export const MAX_NDJSON_LINE_BYTES = 32 * 1024 * 1024;

/**
 * Pass-through that counts bytes since the last newline and fires
 * `onExceeded` once a single line exceeds `maxLineBytes` — readline never
 * sees the oversized line, so its internal buffer stays bounded. After the
 * cap trips, all further input is swallowed (the callback handles teardown;
 * erroring the Transform mid-pipe would raise an uncaught stream error).
 */
function createLineCapGuard(maxLineBytes: number, onExceeded: (err: Error) => void): Transform {
  // Bytes accumulated on the current (not yet newline-terminated) line.
  let lineBytes = 0;
  let exceeded = false;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (exceeded) {
        callback();
        return;
      }
      let start = 0;
      while (start <= chunk.length) {
        const nl = chunk.indexOf(0x0a, start);
        const segmentEnd = nl === -1 ? chunk.length : nl;
        lineBytes += segmentEnd - start;
        if (lineBytes > maxLineBytes) {
          exceeded = true;
          onExceeded(new Error(`NDJSON line exceeded ${maxLineBytes} bytes without a newline`));
          callback();
          return;
        }
        if (nl === -1) break;
        lineBytes = 0;
        start = nl + 1;
      }
      callback(null, chunk);
    },
  });
}

export interface NdjsonConnection {
  sendRequest<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  sendNotification(method: string, params?: unknown): void;
  onRequest<T = unknown>(method: string, handler: (params: T) => unknown | Promise<unknown>): void;
  onNotification(method: string, handler: (params?: unknown) => void): void;
  listen(): void;
  dispose(): void;
}

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

export function createNdjsonConnection(readable: Readable, writable: Writable): NdjsonConnection {
  let disposed = false;
  let rl: ReturnType<typeof createInterface> | null = null;

  const notificationHandlers = new Map<string, (params?: unknown) => void>();

  // Write queue for backpressure: while a previous write is waiting for
  // 'drain', later sends chain behind it so ordering is preserved and the
  // stream's internal buffer stops growing unboundedly. `null` when idle —
  // the common no-backpressure case writes synchronously, exactly like the
  // pre-queue behavior. Links never reject, so nothing can unhandled-reject.
  let writeChain: Promise<void> | null = null;

  function waitForDrain(): Promise<void> {
    return new Promise((resolve) => {
      const settle = (): void => {
        writable.off("drain", settle);
        writable.off("error", settle);
        writable.off("close", settle);
        resolve();
      };
      writable.once("drain", settle);
      // A dead peer never emits 'drain' — settle on error/close so queued
      // writes fall through to the dead-stream guard instead of hanging.
      writable.once("error", settle);
      writable.once("close", settle);
    });
  }

  /**
   * Write one line, returning a drain promise when the stream reported
   * backpressure, or undefined when the write was accepted outright.
   */
  function writeLine(line: string): Promise<void> | undefined {
    // The peer (guest process) can die at any time — writing to its closed
    // stdin would emit EPIPE/ERR_STREAM_DESTROYED. On a listener-less stream
    // that becomes an uncaughtException and takes down the whole host, so
    // never write to a dead stream and swallow any residual write error.
    if (disposed || writable.destroyed || writable.writableEnded) return;
    try {
      if (writable.write(line)) return;
    } catch {
      // Peer went away between the check and the write — nothing to do.
      return;
    }
    return waitForDrain();
  }

  function send(msg: unknown): void {
    if (disposed || writable.destroyed || writable.writableEnded) return;
    const line = `${JSON.stringify(msg)}\n`;
    const wait = writeChain === null ? writeLine(line) : writeChain.then(() => writeLine(line));
    if (wait === undefined) return;
    const chained: Promise<void> = wait.then(() => {
      // Last link in the chain: return to the synchronous fast path.
      if (writeChain === chained) writeChain = null;
    });
    writeChain = chained;
  }

  // json-rpc-2.0 handles id allocation, response correlation, and pending
  // rejection; `send` above is its transport. The errorListener is silenced —
  // handler failures already travel back to the peer as -32603 responses.
  const client = new JSONRPCClient((payload) => {
    send(payload);
  });
  const server = new JSONRPCServer({ errorListener: () => undefined });
  // The library defaults handler failures to error code 0; the guest protocol
  // uses JSON-RPC's -32603 (internal error) with the thrown message.
  server.mapErrorToJSONRPCErrorResponse = (id, error) =>
    createJSONRPCErrorResponse(id, JSONRPCErrorCode.InternalError, errorMessage(error));

  function rejectAllPending(reason: string): void {
    if (disposed) return;
    disposed = true;
    client.rejectAllPendingRequests(reason);
  }

  function handleLine(line: string): void {
    const msg = parseJsonRpcMessage(line);
    if (!msg) return;
    switch (msg.kind) {
      case "response":
        client.receive(msg.data as Parameters<typeof client.receive>[0]);
        return;
      case "request": {
        const req = msg.data;
        if (!server.hasMethod(req.method)) {
          // Sent directly to preserve the exact wire message the guest
          // already sees (the library's own text omits the method name).
          send({
            jsonrpc: "2.0",
            id: req.id,
            error: { code: -32_601, message: `Method not found: ${req.method}` },
          });
          return;
        }
        void server.receive(req).then((response) => {
          if (response) send(response);
        });
        return;
      }
      case "notification": {
        // Notification handlers run bare inside the readline 'line' listener
        // — a throw (or a rejected promise from an async handler) would be an
        // uncaughtException/unhandledRejection on the whole host. Contain both.
        const handler = notificationHandlers.get(msg.data.method);
        if (!handler) return;
        try {
          Promise.resolve(handler(msg.data.params)).catch((err: unknown) => {
            console.error(
              `NDJSON notification handler "${msg.data.method}" rejected: ${errorMessage(err)}`,
            );
          });
        } catch (err) {
          console.error(
            `NDJSON notification handler "${msg.data.method}" threw: ${errorMessage(err)}`,
          );
        }
        return;
      }
      default:
        return;
    }
  }

  return {
    sendRequest<T = unknown>(
      method: string,
      params?: unknown,
      timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
    ): Promise<T> {
      if (disposed) return Promise.reject(new Error("Connection disposed"));
      const requester =
        timeoutMs > 0 && Number.isFinite(timeoutMs)
          ? client.timeout(timeoutMs, (id) =>
              createJSONRPCErrorResponse(id, 0, `RPC "${method}" timed out after ${timeoutMs}ms`),
            )
          : client;
      return Promise.resolve(requester.request(method, params, undefined));
    },

    sendNotification(method: string, params?: unknown): void {
      if (disposed) return;
      client.notify(method, params, undefined);
    },

    onRequest<T = unknown>(
      method: string,
      handler: (params: T) => unknown | Promise<unknown>,
    ): void {
      server.addMethod(method, handler as (params: unknown) => unknown | Promise<unknown>);
    },

    onNotification(method: string, handler: (params?: unknown) => void): void {
      notificationHandlers.set(method, handler);
    },

    listen(): void {
      // Cap line length BEFORE readline buffers it (see MAX_NDJSON_LINE_BYTES).
      const guard = createLineCapGuard(MAX_NDJSON_LINE_BYTES, (err) => {
        // Fatal transport error: same teardown as a closed connection, with
        // the cap violation as the pending-rejection reason. Destroy the
        // source too so a hostile peer can't keep streaming into the pipe
        // (deferred a tick — this fires from inside the pipe's write path).
        console.error(`NDJSON transport error: ${errorMessage(err)}`);
        rejectAllPending(errorMessage(err));
        rl?.close();
        process.nextTick(() => readable.destroy());
      });
      rl = createInterface({ input: readable.pipe(guard), crlfDelay: Number.POSITIVE_INFINITY });
      rl.on("line", handleLine);
      rl.on("close", () => {
        rejectAllPending("Connection closed");
      });
    },

    dispose(): void {
      rejectAllPending("Connection disposed");
      rl?.close();
    },
  };
}
