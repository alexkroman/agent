// Copyright 2026 the AAI authors. MIT license.
// Fake `ws` WebSocket shared by the TTS adapter specs (AssemblyAI and Rime)
// and `step-speak.test.ts`. It reaches the code under test through each
// opener's `createSocket` seam — pass {@link createFakeWebSocket} — rather than
// by replacing the `ws` module.
//
// It used to be AssemblyAI's alone while `rime.test.ts` and
// `stt/soniox.test.ts` each re-implemented it, and the copies had already
// DIVERGED on the property that matters: soniox's starts CONNECTING and
// flips to OPEN when it fires "open", the other two were pinned OPEN from
// the constructor — so a write-before-open regression was catchable in one
// suite and structurally invisible in the other two. This one matches real
// `ws`: `readyState` is CONNECTING until the "open" event, and it is an
// `EventEmitter`, so an `error` with no listener throws exactly as it would
// crash the host. (Soniox's copy survives because its adapter speaks binary
// frames, reads `bufferedAmount` and reads the close CODE, none of which this
// fake models.)

import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import type { CreateProviderSocket } from "../_socket.ts";

type WsEvent = "open" | "message" | "error" | "close";

export class FakeWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  /** When true, new sockets black-hole: no "open", no "error" — ever. */
  static neverOpen = false;

  readyState: number = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  readonly url: string;
  readonly options: WebSocket.ClientOptions | undefined;

  constructor(url: string, opts?: WebSocket.ClientOptions) {
    super();
    this.url = url;
    this.options = opts;
    FakeWebSocket.instances.push(this);
    // Real `ws` fires "open" asynchronously and is CONNECTING until then;
    // match both, so a send-before-open is a test failure rather than a
    // silently accepted frame.
    if (!FakeWebSocket.neverOpen) {
      queueMicrotask(() => {
        this.readyState = FakeWebSocket.OPEN;
        this._fire("open");
      });
    }
  }

  /** Reset the per-test statics — call from beforeEach. */
  static reset(): void {
    FakeWebSocket.instances.length = 0;
    FakeWebSocket.neverOpen = false;
  }

  /** Every listener on every event — what `dropSocket` must leave at one. */
  listenersTotal(): number {
    let n = 0;
    for (const ev of this.eventNames()) n += this.listenerCount(ev);
    return n;
  }

  /** Every adapter on this fake speaks JSON text frames; a binary one is kept decoded. */
  send(data: string | Uint8Array, _options?: { binary?: boolean }) {
    this.sent.push(typeof data === "string" ? data : new TextDecoder().decode(data));
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this._fire("close");
  }

  /**
   * Real `ws`'s abrupt close — no close frame, no handshake.
   *
   * Modelled because `host/step-speak.ts` uses it for the one case where a
   * polite close is pointless (a socket that never opened, or an exchange that
   * already failed), and a fake without it turns that path into a TypeError
   * that reads as a bug in the code under test.
   */
  terminate() {
    this.readyState = FakeWebSocket.CLOSED;
    this._fire("close");
  }

  _fire(event: WsEvent, ...args: unknown[]) {
    this.emit(event, ...args);
  }

  _msg(payload: unknown) {
    this._fire("message", JSON.stringify(payload));
  }

  _frames(): Record<string, unknown>[] {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
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
