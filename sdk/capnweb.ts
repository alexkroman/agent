// Copyright 2025 the AAI authors. MIT license.
/**
 * MessagePort RPC + WebSocket bridge for capnweb sandbox communication.
 *
 * Provides bidirectional RPC over MessagePort/Worker and WebSocket
 * bridging over MessagePort for capnweb sandboxed workers.
 *
 * @module
 */

import { z } from "zod";
import { errorMessage } from "./_utils.ts";

// ─── RPC Wire Types ──────────────────────────────────────────────────────────

/** RPC call message: `{$: 0, id, m, a}`. id = -1 for fire-and-forget. */
type RpcCall = { $: 0; id: number; m: string; a: unknown[] };

/** RPC result message: `{$: 1, id, v?, e?}`. */
type RpcResult = { $: 1; id: number; v?: unknown; e?: string };

/** Discriminated union of all RPC wire messages. */
type RpcMsg = RpcCall | RpcResult;

/** Type guard: narrows unknown data to {@linkcode RpcCall}. */
function isRpcCall(obj: Record<string, unknown>): obj is RpcCall {
  return (
    obj.$ === 0 && typeof obj.id === "number" && typeof obj.m === "string" && Array.isArray(obj.a)
  );
}

/** Type guard: narrows unknown data to {@linkcode RpcResult}. */
function isRpcResult(obj: Record<string, unknown>): obj is RpcResult {
  return (
    obj.$ === 1 && typeof obj.id === "number" && (obj.e === undefined || typeof obj.e === "string")
  );
}

/** Narrow an unknown `ev.data` to {@linkcode RpcMsg}, or return `undefined`. */
function parseRpcMsg(data: unknown): RpcMsg | undefined {
  if (typeof data !== "object" || data === null || !("$" in data)) return undefined;
  const obj = data as Record<string, unknown>;
  if (isRpcCall(obj)) return obj;
  if (isRpcResult(obj)) return obj;
  return undefined;
}

// ─── MessagePort RPC ─────────────────────────────────────────────────────────

/** Minimal port interface for CapnwebEndpoint. Works with Worker, MessagePort, or worker self. */
export type CapnwebPort = {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent) => void) | null;
};

/** RPC handler function. Receives call arguments and any transferred ports. */
export type RpcHandler = (
  args: unknown[],
  ports: readonly MessagePort[],
) => unknown | Promise<unknown>;

/**
 * Bidirectional RPC endpoint over MessagePort or Worker.
 *
 * Both sides can send calls and handle incoming calls on the same channel.
 *
 * Wire protocol:
 * - Call: `{$: 0, id: number, m: string, a: unknown[]}`
 * - Result: `{$: 1, id: number, v?: unknown, e?: string}`
 * - Notify (fire-and-forget): id = -1, no response sent
 */
export class CapnwebEndpoint {
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private handlers = new Map<string, RpcHandler>();
  private port: CapnwebPort;

  constructor(port: CapnwebPort) {
    this.port = port;
    port.onmessage = (ev: MessageEvent) => this.onMessage(ev);
  }

  /** Register an RPC handler for incoming calls with the given method name. */
  handle(method: string, handler: RpcHandler): void {
    this.handlers.set(method, handler);
  }

  /** Call a remote method and wait for the result. */
  call(method: string, args: unknown[], transfer?: Transferable[]): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ $: 0, id, m: method, a: args }, transfer);
    });
  }

  /** Fire-and-forget: call a remote method without waiting for a response. */
  notify(method: string, args: unknown[], transfer?: Transferable[]): void {
    this.send({ $: 0, id: -1, m: method, a: args }, transfer);
  }

  private send(msg: unknown, transfer?: Transferable[]): void {
    this.port.postMessage(msg, transfer ?? []);
  }

  private onMessage(ev: MessageEvent): void {
    const msg = parseRpcMsg(ev.data);
    if (!msg) return;

    if (msg.$ === 0) {
      // Incoming call
      const { id, m, a } = msg;
      const handler = this.handlers.get(m);
      if (!handler) {
        if (id >= 0) this.send({ $: 1, id, e: `No handler for ${m}` });
        return;
      }
      const ports = [...ev.ports];
      Promise.resolve()
        .then(() => handler(a, ports))
        .then((v) => {
          if (id >= 0) this.send({ $: 1, id, v });
        })
        .catch((err: unknown) => {
          if (id >= 0) {
            this.send({
              $: 1,
              id,
              e: errorMessage(err),
            });
          }
        });
    } else {
      // Incoming result
      const { id, v, e } = msg;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (e !== undefined) {
        pending.reject(new Error(e));
      } else {
        pending.resolve(v);
      }
    }
  }
}

// ─── Request/Response serialization ─────────────────────────────────────────

/** Serialized HTTP request tuple for RPC transport. */
export type SerializedRequest = [
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
];

/** Zod schema for serialized HTTP responses over RPC. */
export const SerializedResponseSchema = z.object({
  status: z.number(),
  headers: z.record(z.string(), z.string()),
  body: z.string(),
});

/** Serialized HTTP response object for RPC transport. */
export type SerializedResponse = z.infer<typeof SerializedResponseSchema>;

/** Serialize a Request for RPC transport. */
export async function serializeRequest(request: Request): Promise<SerializedRequest> {
  return [
    request.url,
    request.method,
    Object.fromEntries(request.headers),
    request.body ? await request.text() : undefined,
  ];
}

/** Reconstruct a Request from its serialized form. */
export function deserializeRequest([url, method, headers, body]: SerializedRequest): Request {
  return new Request(url, { method, headers, ...(body ? { body } : {}) });
}

/** Serialize a Response for RPC transport. */
export async function serializeResponse(response: Response): Promise<SerializedResponse> {
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: await response.text(),
  };
}

/** Reconstruct a Response from its serialized form. */
export function deserializeResponse(result: SerializedResponse): Response {
  return new Response(result.body, {
    status: result.status,
    headers: result.headers,
  });
}

// ─── WebSocket Bridge Protocol ───────────────────────────────────────────────

/**
 * Bridge message format for WebSocket-over-MessagePort:
 * - `{k:0, d:string|ArrayBuffer}` — data frame (binary transferred zero-copy)
 * - `{k:2, code?, reason?}` — close
 * - `{k:3}` — open
 * - `{k:4, m:string}` — error
 */
type BridgeMsg =
  | { k: 0; d: string | ArrayBuffer }
  | { k: 2; code?: number; reason?: string }
  | { k: 3 }
  | { k: 4; m: string };

/** Type guard: narrows unknown data (e.g. from `ev.data`) to {@linkcode BridgeMsg}. */
function isBridgeMsg(data: unknown): data is BridgeMsg {
  return (
    typeof data === "object" &&
    data !== null &&
    "k" in data &&
    typeof (data as { k: unknown }).k === "number"
  );
}

// ─── BridgedWebSocket (standard EventTarget-based) ───────────────────────────

/**
 * Wraps a MessagePort as a standard WebSocket (extends EventTarget).
 * Used in the worker for client connections bridged from the host.
 */
export class BridgedWebSocket extends EventTarget {
  readyState = 0;
  private port: MessagePort;

  constructor(port: MessagePort) {
    super();
    this.port = port;
    port.onmessage = (ev: MessageEvent) => {
      const msg = ev.data;
      if (!isBridgeMsg(msg)) return;
      switch (msg.k) {
        case 0:
          this.dispatchEvent(new MessageEvent("message", { data: msg.d }));
          break;
        case 2:
          this.readyState = 3;
          this.dispatchEvent(
            new CloseEvent("close", {
              ...(msg.code !== undefined ? { code: msg.code } : {}),
              ...(msg.reason !== undefined ? { reason: msg.reason } : {}),
            }),
          );
          break;
        case 3:
          this.readyState = 1;
          this.dispatchEvent(new Event("open"));
          break;
        case 4:
          this.dispatchEvent(new ErrorEvent("error", { message: msg.m }));
          break;
      }
    };
  }

  send(data: string | ArrayBuffer | Uint8Array): void {
    if (this.readyState !== 1) return;
    if (typeof data === "string") {
      this.port.postMessage({ k: 0, d: data });
    } else {
      const ab =
        data instanceof ArrayBuffer
          ? data
          : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      this.port.postMessage({ k: 0, d: ab }, [ab]);
    }
  }

  close(code?: number, reason?: string): void {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    this.port.postMessage({ k: 2, code, reason });
  }
}

// ─── Host-side bridges ───────────────────────────────────────────────────────

/** Minimal EventTarget-based WebSocket accepted by {@linkcode bridgeWebSocketToPort}. */
export type BridgeableWebSocket = {
  readonly readyState: number;
  binaryType?: string;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
};

/** Options for {@linkcode bridgeWebSocketToPort}. */
export type BridgeOptions = {
  /** Optional filter for incoming binary frames. Return `false` to drop. */
  filterBinary?: (data: ArrayBuffer) => boolean;
};

/**
 * Bridges an EventTarget-based WebSocket to a MessagePort.
 * Used on the host side for both client and S2S connections.
 */
export function bridgeWebSocketToPort(
  ws: BridgeableWebSocket,
  port: MessagePort,
  opts?: BridgeOptions,
): void {
  if ("binaryType" in ws) ws.binaryType = "arraybuffer";

  ws.addEventListener("open", () => {
    port.postMessage({ k: 3 });
  });

  ws.addEventListener("message", ((ev: MessageEvent) => {
    const { data } = ev;
    if (typeof data === "string") {
      port.postMessage({ k: 0, d: data });
    } else if (data instanceof ArrayBuffer) {
      if (opts?.filterBinary && !opts.filterBinary(data)) return;
      port.postMessage({ k: 0, d: data }, [data]);
    }
  }) as EventListener);

  ws.addEventListener("close", ((ev: CloseEvent) => {
    port.postMessage({ k: 2, code: ev.code, reason: ev.reason });
  }) as EventListener);

  ws.addEventListener("error", (ev: Event) => {
    const msg = ev instanceof ErrorEvent ? ev.message : "WebSocket error";
    port.postMessage({ k: 4, m: msg });
  });

  // Messages from worker → real WebSocket
  port.onmessage = (ev: MessageEvent) => {
    const msg = ev.data;
    if (!isBridgeMsg(msg)) return;
    switch (msg.k) {
      case 0:
        if (ws.readyState === 1) ws.send(msg.d);
        break;
      case 2:
        ws.close(msg.code, msg.reason);
        break;
    }
  };
}
