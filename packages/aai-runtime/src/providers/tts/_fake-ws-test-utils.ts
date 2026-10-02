// Copyright 2026 the AAI authors. MIT license.
/**
 * Fake `ws` WebSocket shared by every provider spec that drives a socket (the
 * TTS adapters, `step-speak`, and the Soniox STT adapter). It reaches the code
 * under test through each opener's `createSocket` seam — pass
 * {@link createFakeWebSocket} — rather than by replacing the `ws` module.
 *
 * It matches real `ws` where an adapter can tell the difference: an
 * `EventEmitter` (so an `error` with no listener throws as it would crash the
 * host), `readyState` CONNECTING until "open" fires (so a send-before-open is a
 * test failure rather than a silently accepted frame), binary as well as text
 * frames, a `bufferedAmount` for backpressure, and a close CODE on "close".
 */

import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import type { CreateProviderSocket } from "../_socket.ts";

type WsEvent = "open" | "message" | "error" | "close";

export class FakeWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  /** When true, new sockets black-hole: no "open", no "error" — ever. */
  static neverOpen = false;

  readyState: number = FakeWebSocket.CONNECTING;
  /** Every frame sent, text or binary, in order. */
  sent: (string | Uint8Array)[] = [];
  /** What the adapter reads for backpressure; a spec sets it. */
  bufferedAmount = 0;
  readonly url: string;
  readonly options: WebSocket.ClientOptions | undefined;

  constructor(url: string, opts?: WebSocket.ClientOptions) {
    super();
    this.url = url;
    this.options = opts;
    FakeWebSocket.instances.push(this);
    // Real `ws` fires "open" asynchronously and is CONNECTING until then.
    if (!FakeWebSocket.neverOpen) {
      queueMicrotask(() => {
        this.readyState = FakeWebSocket.OPEN;
        this.emit("open");
      });
    }
  }

  /** Reset the per-test statics — call from beforeEach. */
  static reset(): void {
    FakeWebSocket.instances.length = 0;
    FakeWebSocket.neverOpen = false;
  }

  /** The most recently constructed socket; throws when none was. */
  static latest(): FakeWebSocket {
    const ws = FakeWebSocket.instances.at(-1);
    if (!ws) throw new Error("no FakeWebSocket was constructed");
    return ws;
  }

  /** Every listener on every event — what `dropSocket` must leave at one. */
  listenersTotal(): number {
    let n = 0;
    for (const ev of this.eventNames()) n += this.listenerCount(ev);
    return n;
  }

  send(data: string | Uint8Array, _options?: { binary?: boolean }): void {
    this.sent.push(data);
  }

  /** A polite close: CLOSING, then "close" with `code`, then CLOSED. */
  close(code = 1000): void {
    this.readyState = FakeWebSocket.CLOSING;
    this.emit("close", code);
    this.readyState = FakeWebSocket.CLOSED;
  }

  /**
   * Real `ws`'s abrupt close — no close frame, no handshake. `host/step-speak.ts`
   * uses it for a socket that never opened or an exchange that already failed.
   */
  terminate(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", 1006);
  }

  _fire(event: WsEvent, ...args: unknown[]): void {
    this.emit(event, ...args);
  }

  _msg(payload: unknown): void {
    this.emit("message", JSON.stringify(payload));
  }

  /** The TEXT frames sent, parsed. */
  _frames(): Record<string, unknown>[] {
    return this.sent
      .filter((s): s is string => typeof s === "string")
      .map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

/** The `createSocket` seam's fake: a {@link FakeWebSocket}, recorded in `instances`. */
export const createFakeWebSocket: CreateProviderSocket = (url, options) =>
  new FakeWebSocket(url, options);

/** Base64 of one PCM16 LE sample per value. */
export function pcmBase64(samples: number[]): string {
  const buf = Buffer.alloc(samples.length * 2);
  for (const [i, v] of samples.entries()) buf.writeInt16LE(v, i * 2);
  return buf.toString("base64");
}
