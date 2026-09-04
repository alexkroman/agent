// Copyright 2025 the AAI authors. MIT license.
// WebSocket transport for host↔guest JSON-RPC 2.0 communication.
//
// The host dials the guest harness's WebSocket (through its Modal tunnel);
// this module frames JSON-RPC over that socket. JSON-RPC id allocation,
// response correlation, per-request timeouts, and request dispatch are
// delegated to the `json-rpc-2.0` library. One JSON object per text frame
// with `jsonrpc`/`id`/`method`/`params`/`result`/`error` fields, -32601 for
// unknown methods and -32603 for handler failures (the guest harness speaks
// exactly this).

import { errorMessage, safeJsonParse } from "@alexkroman1/aai";
import { isRecord } from "@alexkroman1/aai/utils";
import {
  createJSONRPCErrorResponse,
  JSONRPCClient,
  JSONRPCErrorCode,
  JSONRPCServer,
} from "json-rpc-2.0";
import { z } from "zod";
import { createLogger } from "./logger.ts";

const log = createLogger("rpc");

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

type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;
type JsonRpcNotification = z.infer<typeof JsonRpcNotificationSchema>;
type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>;

/**
 * Default timeout for a host→guest request. A wedged guest (e.g. a bundle
 * whose top level never resolves) must not leave a pending request — and
 * anything awaiting it, like shutdownSandbox holding the slug lock — hanging
 * forever.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Cap on frames buffered between the socket opening and `listen()`.
 *
 * Generous relative to what the window can legitimately hold — every caller
 * registers handlers and calls `listen()` in the same task, so nothing should
 * arrive at all — and finite because the peer is a sandbox running tenant code.
 * See {@link createRpcConnection} for why overflow drops the newest.
 */
const MAX_PRE_LISTEN_FRAMES = 64;

/** Method-name → `{ params, result }` map for one direction of an RPC link. */
export type RpcMethodMap = Record<string, { params: unknown; result: unknown }>;

/** Method-name → params map for one direction's notifications. */
export type RpcNotificationMap = Record<string, unknown>;

/**
 * The four directional surfaces of one RPC link, seen from this side.
 *
 * A concrete schema (e.g. `GuestRpcSchema` in rpc-schemas.ts) makes method
 * names and request params compile-time-checked at every call site. Results
 * and incoming params stay `unknown` in concrete schemas on purpose: they
 * are untrusted wire data, and the type system must not claim otherwise —
 * validation (Zod) at the receiving site is the contract.
 */
export type RpcSchema = {
  requestsOut: RpcMethodMap;
  requestsIn: RpcMethodMap;
  notificationsOut: RpcNotificationMap;
  notificationsIn: RpcNotificationMap;
};

export interface RpcConnection<S extends RpcSchema = RpcSchema> {
  // `params` is required exactly when the schema's params type cannot be
  // undefined — so `sendRequest("studio/session-init")` with no params is a missing-argument error
  // while an untyped connection (params: unknown) keeps its 1-arg form.
  sendRequest<M extends keyof S["requestsOut"] & string>(
    method: M,
    ...args: undefined extends S["requestsOut"][M]["params"]
      ? [params?: S["requestsOut"][M]["params"], timeoutMs?: number]
      : [params: S["requestsOut"][M]["params"], timeoutMs?: number]
  ): Promise<S["requestsOut"][M]["result"]>;
  sendNotification<M extends keyof S["notificationsOut"] & string>(
    method: M,
    params?: S["notificationsOut"][M],
  ): void;
  onRequest<M extends keyof S["requestsIn"] & string>(
    method: M,
    handler: (params: S["requestsIn"][M]["params"]) => unknown | Promise<unknown>,
  ): void;
  onNotification<M extends keyof S["notificationsIn"] & string>(
    method: M,
    handler: (params?: S["notificationsIn"][M]) => void,
  ): void;
  listen(): void;
  dispose(): void;
}

/**
 * The subset of `ws`'s WebSocket the transport touches — structural so unit
 * tests can inject fakes without opening sockets. The real WebSocket
 * satisfies it.
 */
export type RpcWebSocket = {
  readonly readyState: number;
  readonly OPEN: number;
  send(data: string): void;
  close(): void;
  on(event: "message", cb: (data: unknown) => void): unknown;
  on(event: "close", cb: () => void): unknown;
};

type ParsedMessage =
  | { kind: "response"; data: JsonRpcResponse }
  | { kind: "request"; data: JsonRpcRequest }
  | { kind: "notification"; data: JsonRpcNotification }
  | null;

function parseJsonRpcMessage(raw: unknown): ParsedMessage {
  const value = safeJsonParse(String(raw));
  if (!isRecord(value)) return null;

  if ("result" in value || "error" in value) {
    const parsed = JsonRpcResponseSchema.safeParse(value);
    return parsed.success ? { kind: "response", data: parsed.data } : null;
  }
  if ("id" in value && "method" in value) {
    const parsed = JsonRpcRequestSchema.safeParse(value);
    return parsed.success ? { kind: "request", data: parsed.data } : null;
  }
  if ("method" in value) {
    const parsed = JsonRpcNotificationSchema.safeParse(value);
    return parsed.success ? { kind: "notification", data: parsed.data } : null;
  }
  return null;
}

/**
 * Wrap an OPEN WebSocket in a typed JSON-RPC connection.
 *
 * Frames received before `listen()` are buffered and replayed when it is
 * called — handler registration (`onRequest`) must complete before any guest
 * message is dispatched, and the socket starts delivering the moment it
 * opens. In practice the guest sends nothing unprompted, but the buffer
 * makes the ordering a non-event rather than a race.
 *
 * That buffer is CAPPED ({@link MAX_PRE_LISTEN_FRAMES}). "The guest sends nothing
 * unprompted" is a property of the peer asserted in a comment, and the peer is a
 * sandbox running tenant code; every caller registers its handlers and calls
 * `listen()` in the same task, so the window is a task long and a cap costs
 * nothing. Overflow drops the NEWEST frame and warns — not the oldest, which is
 * what a ring would do and is exactly backwards here: this is a replay buffer, so
 * the first frame is the one a handler is waiting for.
 */
export function createRpcConnection<S extends RpcSchema = RpcSchema>(
  ws: RpcWebSocket,
): RpcConnection<S> {
  let disposed = false;
  let listening = false;
  const preListenBuffer: unknown[] = [];
  let droppedPreListen = 0;

  const notificationHandlers = new Map<string, (params?: unknown) => void>();

  function send(msg: unknown): void {
    if (disposed || ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Peer went away between the check and the send — the close handler
      // rejects everything pending.
    }
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

  function handleFrame(raw: unknown): void {
    const msg = parseJsonRpcMessage(raw);
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
        // Contained for the same reason as the notification branch below: a
        // rejection here would be an unhandledRejection on the whole host.
        // (Promise.resolve because receive returns a bare PromiseLike.)
        void Promise.resolve(server.receive(req))
          .then((response) => {
            if (response) send(response);
          })
          .catch((err: unknown) => {
            log.error(`request handler "${req.method}" rejected`, {
              error: errorMessage(err),
            });
          });
        return;
      }
      case "notification": {
        // Notification handlers run bare inside the socket's message
        // listener — a throw (or a rejected promise from an async handler)
        // would be an uncaughtException/unhandledRejection on the whole
        // host. Contain both.
        const handler = notificationHandlers.get(msg.data.method);
        if (!handler) return;
        try {
          Promise.resolve(handler(msg.data.params)).catch((err: unknown) => {
            log.error(`notification handler "${msg.data.method}" rejected`, {
              error: errorMessage(err),
            });
          });
        } catch (err) {
          log.error(`notification handler "${msg.data.method}" threw`, {
            error: errorMessage(err),
          });
        }
        return;
      }
      default:
        return;
    }
  }

  ws.on("message", (data) => {
    if (listening) {
      handleFrame(data);
      return;
    }
    if (preListenBuffer.length >= MAX_PRE_LISTEN_FRAMES) {
      // Warn ONCE per connection: a peer flooding a closed window would
      // otherwise make the log the flood.
      droppedPreListen += 1;
      if (droppedPreListen === 1) {
        log.warn(
          `dropping frames sent before listen() — more than ${MAX_PRE_LISTEN_FRAMES} arrived ` +
            "while handlers were still being registered",
        );
      }
      return;
    }
    preListenBuffer.push(data);
  });
  ws.on("close", () => {
    rejectAllPending("Connection closed");
  });

  // The implementation is method-name-agnostic (framing, correlation, and
  // timeouts don't depend on the schema); the single cast below is what
  // projects it onto the caller's typed schema.
  const connection: RpcConnection = {
    sendRequest(
      method: string,
      params?: unknown,
      timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
    ): Promise<unknown> {
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

    onRequest(method: string, handler: (params: unknown) => unknown | Promise<unknown>): void {
      server.addMethod(method, handler);
    },

    onNotification(method: string, handler: (params?: unknown) => void): void {
      notificationHandlers.set(method, handler);
    },

    listen(): void {
      if (listening) return;
      listening = true;
      for (const frame of preListenBuffer.splice(0)) handleFrame(frame);
    },

    dispose(): void {
      rejectAllPending("Connection disposed");
      try {
        ws.close();
      } catch {
        // Already closed/destroyed — nothing to release.
      }
    },
  };
  return connection as RpcConnection<S>;
}
