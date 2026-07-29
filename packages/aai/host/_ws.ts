// Copyright 2026 the AAI authors. MIT license.
/**
 * Shared header-capable WebSocket adapter contract for provider transports
 * that authenticate via custom headers (AssemblyAI S2S, OpenAI Realtime).
 */

import { EventEmitter } from "node:events";
import { pEvent } from "p-event";
import WsWebSocket from "ws";

export type HeaderWebSocket = {
  readonly readyState: number;
  /**
   * Unsent bytes queued in the socket buffer (the `ws` package exposes this).
   * Optional so adapters/stubs without it simply skip the audio backpressure
   * gate (see `_audio-gate.ts`).
   */
  readonly bufferedAmount?: number | undefined;
  send(data: string): void;
  /**
   * `code` is optional but callers should pass one: omitting it sends a
   * statusless close frame, which both ends report as 1005 "No Status
   * Received" — indistinguishable from the peer dropping the connection.
   */
  close(code?: number): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(
    type: "close",
    listener: (event: { code?: number; reason?: string }) => void,
  ): void;
  addEventListener(type: "error", listener: (event: { message?: string }) => void): void;
};

export type CreateHeaderWebSocket = (
  url: string,
  opts: { headers: Record<string, string> },
) => HeaderWebSocket;

// Node's native WebSocket doesn't support custom headers; the `ws` package does.
export const defaultCreateHeaderWebSocket: CreateHeaderWebSocket = (url, opts) =>
  new WsWebSocket(url, { headers: opts.headers }) as unknown as HeaderWebSocket;

/**
 * The connect race shared by the header-WebSocket transports (AssemblyAI S2S,
 * OpenAI Realtime): settle once the socket opens, and route a close or error
 * that arrives *before* the open to the pending connect rather than to the
 * session callbacks, which aren't meaningful yet.
 *
 * Shared because the two transports had already drifted: S2S rejected the
 * connect on a premature `close`, OpenAI Realtime only did so on `error` — so
 * an OpenAI socket that closed without erroring (an auth rejection that closes
 * the connection) left `start()` awaiting a promise that could never settle.
 * Owning the state machine here makes that failure mode impossible to forget.
 */
export type WsOpenRace = {
  /** Resolves when the socket opens; rejects if it closes/errors first. */
  readonly promise: Promise<void>;
  /** The socket opened — settle the race. */
  markOpen(): void;
  /** Still connecting? Then a close/error belongs to the connect, not the session. */
  isOpening(): boolean;
  /** Fail the pending connect. No-op once opened (or already failed). */
  fail(err: Error): void;
};

export function createWsOpenRace(): WsOpenRace {
  // p-event owns the deferred: it resolves on the first "open" and rejects
  // with the Error emitted as "error" (its default rejection event). The race
  // listens on a private emitter rather than the socket itself because the
  // consumers own the socket listeners — they construct the rejection Errors
  // and read `isOpening()` synchronously *during* the close/error dispatch,
  // before any promise settlement could be observed.
  const emitter = new EventEmitter();
  const promise = pEvent(emitter, "open").then(() => undefined);
  let settled = false;
  // The connect rejection is always consumed by the caller's `await`, but if it
  // fails before that await is reached Node would report an unhandled rejection.
  promise.catch(() => undefined);
  return {
    promise,
    markOpen(): void {
      if (settled) return;
      settled = true;
      emitter.emit("open");
    },
    isOpening: () => !settled,
    fail(err: Error): void {
      if (settled) return;
      settled = true;
      emitter.emit("error", err);
    },
  };
}
