// Copyright 2025 the AAI authors. MIT license.
/**
 * MessagePort RPC + WebSocket bridge for capnweb sandbox communication.
 *
 * Provides bidirectional RPC over MessagePort/Worker and WebSocket
 * bridging for both standard WebSocket (client connections) and
 * S2sWebSocket (.on()-style API for S2S connections).
 *
 * @module
 */

import type { S2sWebSocket } from "./s2s.ts";

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
    if (transfer && transfer.length > 0) {
      this.port.postMessage(msg, transfer);
    } else {
      this.port.postMessage(msg);
    }
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
              e: err instanceof Error ? err.message : String(err),
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

// ─── WebSocket Bridge Protocol ───────────────────────────────────────────────

/**
 * Bridge message format for WebSocket-over-MessagePort:
 * - `{k:0, d:string}` — text frame
 * - `{k:1, d:ArrayBuffer}` — binary frame (transferred zero-copy)
 * - `{k:2, code?, reason?}` — close
 * - `{k:3}` — open
 * - `{k:4, m:string}` — error
 */
type BridgeMsg =
  | { k: 0; d: string }
  | { k: 1; d: ArrayBuffer }
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
        case 1:
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
      this.port.postMessage({ k: 1, d: ab }, [ab]);
    }
  }

  close(code?: number, reason?: string): void {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    this.port.postMessage({ k: 2, code, reason });
  }
}

// ─── BridgedS2sWebSocket (.on()-style API) ───────────────────────────────────

/**
 * Wraps a MessagePort as an {@linkcode S2sWebSocket} (.on() event API).
 * Used in the worker for S2S connections bridged from the host.
 */
export function createBridgedS2sWebSocket(port: MessagePort): S2sWebSocket {
  let readyState = 0;
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>();

  function emit(event: string, ...args: unknown[]): void {
    for (const h of handlers.get(event) ?? []) h(...args);
  }

  port.onmessage = (ev: MessageEvent) => {
    const msg = ev.data;
    if (!isBridgeMsg(msg)) return;
    switch (msg.k) {
      case 0:
        emit("message", msg.d);
        break;
      case 2:
        readyState = 3;
        emit("close", msg.code, msg.reason);
        break;
      case 3:
        readyState = 1;
        emit("open");
        break;
      case 4:
        emit("error", new Error(msg.m));
        break;
    }
  };

  return {
    get readyState() {
      return readyState;
    },
    send(data: string): void {
      if (readyState !== 1) return;
      port.postMessage({ k: 0, d: data });
    },
    close(): void {
      if (readyState >= 2) return;
      readyState = 2;
      port.postMessage({ k: 2 });
    },
    on(event: string, handler: (...args: unknown[]) => void): void {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)?.push(handler);
    },
  };
}

// ─── Host-side bridges ───────────────────────────────────────────────────────

/**
 * Bridges a standard WebSocket (e.g. from `Deno.upgradeWebSocket`) to a
 * MessagePort. Used on the host side for client connections.
 */
export function bridgeWebSocketToPort(ws: WebSocket, port: MessagePort): void {
  ws.binaryType = "arraybuffer";

  ws.addEventListener("open", () => {
    port.postMessage({ k: 3 });
  });

  ws.addEventListener("message", ((ev: MessageEvent) => {
    const { data } = ev;
    if (typeof data === "string") {
      port.postMessage({ k: 0, d: data });
    } else if (data instanceof ArrayBuffer) {
      port.postMessage({ k: 1, d: data }, [data]);
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
      case 1:
        if (ws.readyState === 1) ws.send(msg.d);
        break;
      case 2:
        ws.close(msg.code, msg.reason);
        break;
    }
  };
}

/**
 * Bridges a ws-style {@linkcode S2sWebSocket} to a MessagePort.
 * Used on the host side for S2S connections to AssemblyAI.
 */
export function bridgeS2sWebSocketToPort(ws: S2sWebSocket, port: MessagePort): void {
  ws.on("open", () => {
    port.postMessage({ k: 3 });
  });

  ws.on("message", (data: unknown) => {
    port.postMessage({ k: 0, d: String(data) });
  });

  ws.on("close", (code: unknown, reason: unknown) => {
    port.postMessage({
      k: 2,
      code: typeof code === "number" ? code : undefined,
      reason: String(reason ?? ""),
    });
  });

  ws.on("error", (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    port.postMessage({ k: 4, m: msg });
  });

  // Messages from worker → real S2S WebSocket
  port.onmessage = (ev: MessageEvent) => {
    const msg = ev.data;
    if (!isBridgeMsg(msg)) return;
    switch (msg.k) {
      case 0:
        if (ws.readyState === 1) ws.send(msg.d);
        break;
      case 2:
        ws.close();
        break;
    }
  };
}
