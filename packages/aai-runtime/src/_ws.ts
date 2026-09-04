// Copyright 2026 the AAI authors. MIT license.
/**
 * Shared header-capable WebSocket adapter contract for provider transports
 * that authenticate via custom headers (AssemblyAI S2S, OpenAI Realtime).
 */

import { EventEmitter } from "node:events";
import { omitUndefined } from "@alexkroman1/aai/utils";
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
  options: { headers: Record<string, string> },
) => HeaderWebSocket;

/**
 * Options every provider-facing `ws` client must carry.
 *
 * **`ws` defaults `perMessageDeflate` to TRUE on clients** and FALSE on
 * servers, so the asymmetry is easy to miss: our inbound session sockets
 * (`WebSocketServer` in `host/server.ts`) decline compression by default,
 * while every outbound provider socket OFFERS it, and any provider that
 * accepts leaves us holding a zlib deflate+inflate context per socket for the
 * life of the session.
 *
 * That is not a rounding error. Measured on 200 client sockets exchanging
 * PCM16 frames, with the peer accepting the extension versus declining it:
 * **+321 KiB RSS per socket** (405 KiB vs 84 KiB) and **~4.5x the CPU** for
 * the same audio (2223 ms vs 491 ms). Pipeline mode opens two provider sockets
 * per session, so it is paid twice per concurrent call — more than every other
 * per-session allocation combined.
 *
 * And it buys nothing: these sockets carry PCM16 (or base64 of it, or an
 * already-compressed codec), which is high-entropy and does not deflate. The
 * compression is pure overhead on the one path that runs per session.
 *
 * Whether it is currently being paid depends on each provider's server
 * accepting the offer — which is exactly why it is disabled here rather than
 * left to them.
 */
export const PROVIDER_WS_OPTIONS = { perMessageDeflate: false } as const;

// Node's native WebSocket doesn't support custom headers; the `ws` package does.
export const defaultCreateHeaderWebSocket: CreateHeaderWebSocket = (url, options) =>
  openHeaderWebSocket(url, options);

/**
 * The same client, with a frame cap.
 *
 * A second function rather than a `maxPayload` on {@link CreateHeaderWebSocket},
 * and the reason is a gate: that type is part of the CONTRACTED `runtime` and
 * `server` capabilities (`RuntimeOptions.createWebSocket`), so widening it moves
 * two epochs and obliges two frozen templates — for a cap on a socket no provider
 * opens. This is not on that surface.
 *
 * `platform-socket.ts` is the caller: its peer refuses a frame over
 * `MAX_PLATFORM_SOCKET_FRAME_BYTES` and a reader that would accept one is a
 * socket that dies mid-run rather than a request that is refused. It goes through
 * here rather than opening its own `ws` because this module owns the ONE
 * narrowing into {@link HeaderWebSocket}, and a second one is a second thing to
 * keep true.
 *
 * @internal
 */
export function openHeaderWebSocket(
  url: string,
  options: { headers: Record<string, string>; maxPayload?: number | undefined },
): HeaderWebSocket {
  return new WsWebSocket(url, {
    headers: options.headers,
    ...omitUndefined({ maxPayload: options.maxPayload }),
    ...PROVIDER_WS_OPTIONS,
  }) as unknown as HeaderWebSocket;
}

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
