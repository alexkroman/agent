// Copyright 2025 the AAI authors. MIT license.
/**
 * capnweb integration + WebSocket bridge for sandboxed worker communication.
 *
 * Provides a custom {@linkcode WorkerPortTransport} that allows capnweb RPC
 * to share a Worker port with non-RPC messages (port transfers, bridge
 * protocol), plus WebSocket bridging over MessagePort.
 *
 * @module
 */

import { RpcSession, type RpcSessionOptions, RpcTarget, type RpcTransport } from "capnweb";
import { CloseEventImpl, ErrorEventImpl } from "./_polyfills.ts";

export { RpcSession, type RpcSessionOptions, RpcTarget, type RpcTransport };

// ─── Worker Port Transport ──────────────────────────────────────────────────

/** Minimal port interface for {@linkcode WorkerPortTransport}. Works with Worker, self, or MessagePort. */
export type WorkerPort = {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  addEventListener(type: string, listener: (ev: MessageEvent) => void): void;
};

/** Callback for non-RPC messages received on the port (e.g. port transfers). */
export type NonRpcHandler = (data: unknown, ports: readonly MessagePort[]) => void;

/**
 * Custom {@linkcode RpcTransport} for capnweb RPC over Worker-like ports.
 *
 * capnweb RPC uses string messages. This transport filters incoming messages:
 * - Strings → queued for RPC
 * - `null` → peer closed, treated as error
 * - Anything else → forwarded to the optional `onNonRpc` callback
 *
 * This allows RPC and port-transfer messages to coexist on the same channel.
 */
export class WorkerPortTransport implements RpcTransport {
  #port: WorkerPort;
  #receiveQueue: string[] = [];
  #receiveResolver: ((value: string) => void) | undefined;
  #receiveRejecter: ((reason: Error) => void) | undefined;
  #error?: Error;

  constructor(port: WorkerPort, onNonRpc?: NonRpcHandler) {
    this.#port = port;
    port.addEventListener("message", (ev: MessageEvent) => {
      if (this.#error) return;
      if (typeof ev.data === "string") {
        if (this.#receiveResolver) {
          this.#receiveResolver(ev.data);
          this.#receiveResolver = undefined;
          this.#receiveRejecter = undefined;
        } else {
          this.#receiveQueue.push(ev.data);
        }
      } else if (ev.data === null) {
        this.#receivedError(new Error("Peer closed connection."));
      } else {
        onNonRpc?.(ev.data, [...(ev.ports ?? [])]);
      }
    });
  }

  async send(message: string): Promise<void> {
    if (this.#error) throw this.#error;
    this.#port.postMessage(message);
  }

  async receive(): Promise<string> {
    if (this.#receiveQueue.length > 0) {
      // biome-ignore lint/style/noNonNullAssertion: length check above guarantees non-empty
      return this.#receiveQueue.shift()!;
    }
    if (this.#error) throw this.#error;
    return new Promise((resolve, reject) => {
      this.#receiveResolver = resolve;
      this.#receiveRejecter = reject;
    });
  }

  abort(reason: unknown): void {
    try {
      this.#port.postMessage(null);
    } catch {}
    const err = reason instanceof Error ? reason : new Error(String(reason));
    if (!this.#error) this.#error = err;
  }

  #receivedError(reason: Error): void {
    if (!this.#error) {
      this.#error = reason;
      if (this.#receiveRejecter) {
        this.#receiveRejecter(reason);
        this.#receiveResolver = undefined;
        this.#receiveRejecter = undefined;
      }
    }
  }
}

// ─── RPC Session Helper ─────────────────────────────────────────────────────

/** Options for {@linkcode createRpcSession}. */
export type RpcSessionInit = {
  /** The Worker-like port to communicate over. */
  port: WorkerPort;
  /** Local RPC target to expose to the peer. */
  localMain?: RpcTarget;
  /** Callback for non-RPC messages (port transfers). */
  onTransfer?: NonRpcHandler;
  /** capnweb session options. */
  options?: RpcSessionOptions;
};

/**
 * Create a capnweb RPC session over a Worker-like port.
 *
 * Returns the remote stub for calling methods on the peer's `localMain`.
 * Non-RPC messages (objects, not strings) are forwarded to `onTransfer`.
 */
// biome-ignore lint/suspicious/noExplicitAny: capnweb stubs are dynamically typed proxies
export function createRpcSession(init: RpcSessionInit): any {
  const transport = new WorkerPortTransport(init.port, init.onTransfer);
  const session = new RpcSession(transport, init.localMain, init.options);
  return session.getRemoteMain();
}

// ─── Port Transfer Protocol ─────────────────────────────────────────────────

/**
 * Transfer message format for port-transfer operations that can't go
 * through capnweb RPC (which only supports string serialization):
 *
 * - `{_t: "handleWs", skipGreeting: boolean}` — host→worker: new client WebSocket
 * - `{_t: "createWs", url: string, headers: string}` — worker→host: request S2S WebSocket
 */
export type TransferMessage =
  | { _t: "handleWs"; skipGreeting: boolean }
  | { _t: "createWs"; url: string; headers: string };

/** Type guard for {@linkcode TransferMessage}. */
export function isTransferMessage(data: unknown): data is TransferMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    "_t" in data &&
    typeof (data as { _t: unknown })._t === "string"
  );
}

/** Send a port-transfer message with transferred MessagePorts. */
export function sendTransfer(
  port: WorkerPort,
  msg: TransferMessage,
  transfer: Transferable[],
): void {
  port.postMessage(msg, transfer);
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
            new CloseEventImpl("close", {
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
          this.dispatchEvent(new ErrorEventImpl("error", { message: msg.m }));
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
    const msg = "message" in ev && typeof ev.message === "string" ? ev.message : "WebSocket error";
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
