// Copyright 2026 the AAI authors. MIT license.
/**
 * Adapts an eve WebSocket peer to the `SessionWebSocket` interface that
 * `wireSessionSocket` (aai's voice protocol handler) consumes.
 *
 * Eve's channel WebSocket surface is hook-based — the route returns
 * `open`/`message`/`close`/`error` callbacks and each receives the peer —
 * while aai's handler expects an addEventListener-style socket. The bridge
 * captures the listeners `wireSessionSocket` registers and exposes
 * `dispatch*` methods for the channel hooks to call.
 *
 * Structural on the peer side (`send`/`close` only) so it needs no import
 * from `eve` and tests need no eve runtime.
 */

import type { SessionWebSocket } from "@alexkroman1/aai/runtime";

/** WebSocket readyState values (WHATWG): the bridge only needs OPEN/CLOSED. */
const OPEN = 1;
const CLOSED = 3;

/** The subset of eve's `WebSocketPeer` the bridge uses. */
export interface VoicePeerLike {
  send(data: unknown, options?: { compress?: boolean }): unknown;
  close(code?: number, reason?: string): void;
}

/** A bridged socket plus the dispatchers the channel's WS hooks call. */
export interface PeerSocketBridge {
  /** The facade to hand to `wireSessionSocket`. */
  readonly socket: SessionWebSocket;
  /** Call from the channel's `open` hook (after wiring the socket). */
  dispatchOpen(): void;
  /**
   * Call from the channel's `message` hook with the normalized frame:
   * a `string` for text frames, a `Uint8Array` for binary (audio) frames.
   */
  dispatchMessage(data: string | Uint8Array): void;
  /** Call from the channel's `close` hook. */
  dispatchClose(details?: { code?: number; reason?: string }): void;
  /** Call from the channel's `error` hook. */
  dispatchError(message?: string): void;
}

type OpenListener = () => void;
type CloseListener = (event: { code?: number; reason?: string }) => void;
type MessageListener = (event: { data: unknown }) => void;
type ErrorListener = (event: { message?: string }) => void;

/** Build a {@link SessionWebSocket} facade over an eve WebSocket peer. */
export function bridgePeerSocket(peer: VoicePeerLike): PeerSocketBridge {
  let readyState = OPEN; // eve completes the upgrade before `open` fires
  const openListeners: OpenListener[] = [];
  const closeListeners: CloseListener[] = [];
  const messageListeners: MessageListener[] = [];
  const errorListeners: ErrorListener[] = [];

  function addEventListener(type: "open", listener: OpenListener): void;
  function addEventListener(type: "close", listener: CloseListener): void;
  function addEventListener(type: "message", listener: MessageListener): void;
  function addEventListener(type: "error", listener: ErrorListener): void;
  function addEventListener(
    type: "open" | "close" | "message" | "error",
    listener: OpenListener | CloseListener | MessageListener | ErrorListener,
  ): void {
    switch (type) {
      case "open":
        openListeners.push(listener as OpenListener);
        return;
      case "close":
        closeListeners.push(listener as CloseListener);
        return;
      case "message":
        messageListeners.push(listener as MessageListener);
        return;
      case "error":
        errorListeners.push(listener as ErrorListener);
        return;
      default:
        return;
    }
  }

  const socket: SessionWebSocket = {
    get readyState() {
      return readyState;
    },
    send(data) {
      peer.send(data);
    },
    close(code, reason) {
      readyState = CLOSED;
      peer.close(code, reason);
    },
    addEventListener,
  };

  return {
    socket,
    dispatchOpen() {
      for (const l of [...openListeners]) l();
    },
    dispatchMessage(data) {
      for (const l of [...messageListeners]) l({ data });
    },
    dispatchClose(details) {
      readyState = CLOSED;
      for (const l of [...closeListeners]) l(details ?? {});
    },
    dispatchError(message) {
      for (const l of [...errorListeners]) l(message === undefined ? {} : { message });
    },
  };
}
