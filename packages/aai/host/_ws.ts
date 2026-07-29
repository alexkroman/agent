// Copyright 2026 the AAI authors. MIT license.
/**
 * Shared header-capable WebSocket adapter contract for provider transports
 * that authenticate via custom headers (AssemblyAI S2S, OpenAI Realtime).
 */

import WsWebSocket from "ws";

export type HeaderWebSocket = {
  readonly readyState: number;
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
  const opening = Promise.withResolvers<void>();
  let settled = false;
  // The connect rejection is always consumed by the caller's `await`, but if it
  // fails before that await is reached Node would report an unhandled rejection.
  opening.promise.catch(() => undefined);
  return {
    promise: opening.promise,
    markOpen(): void {
      if (settled) return;
      settled = true;
      opening.resolve();
    },
    isOpening: () => !settled,
    fail(err: Error): void {
      if (settled) return;
      settled = true;
      opening.reject(err);
    },
  };
}
