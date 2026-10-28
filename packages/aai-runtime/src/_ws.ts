// Copyright 2026 the AAI authors. MIT license.
/**
 * Shared header-capable WebSocket adapter contract for provider transports
 * that authenticate via custom headers (AssemblyAI S2S, OpenAI Realtime).
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import WsWebSocket from "ws";

/** The slice of a `ws` client a header-authenticated provider transport drives. */
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

/** The slice of a stream {@link createTickCorker} drives. */
export type Corkable = { cork(): void; uncork(): void };

/**
 * Cork `socket` at the first write of a tick and uncork it once the tick's
 * synchronous work is done, so every frame sent in between leaves as ONE write.
 * Returns the function to call before each write.
 *
 * **Over TLS, the second write of a tick otherwise waits for the event loop.**
 * Node's TLS layer completes a write it flushed synchronously by deferring the
 * completion to `setImmediate`, and holds any further write until then — so a
 * second frame sent in the same tick (AssemblyAI TTS's `Generate`+`Flush`, the
 * flush that STARTS synthesis) leaves only after everything else the process does
 * in that loop turn. Measured against a local TLS peer: 2-5 ms per flush on an
 * idle host, and the full length of whatever synchronous work follows the send
 * under load (21 ms behind a 20 ms busy loop, vs 0.3 ms corked).
 *
 * `process.nextTick` rather than a microtask or a timer: it runs before the loop
 * yields, after the current microtask queue drains, so the release costs no I/O
 * turn and still catches frames sent from a chain of promise continuations.
 */
export function createTickCorker(
  socket: Corkable,
  defer: (release: () => void) => void = (release) => process.nextTick(release),
): () => void {
  let corked = false;
  const release = (): void => {
    corked = false;
    socket.uncork();
  };
  return () => {
    if (corked) return;
    corked = true;
    socket.cork();
    defer(release);
  };
}

/**
 * A `ws` client whose frames sent in one tick leave in one write — see
 * {@link createTickCorker} for why that matters on a TLS provider socket.
 */
export class CoalescingWebSocket extends WsWebSocket {
  #cork: (() => void) | undefined;

  constructor(url: string, options: WsWebSocket.ClientOptions) {
    super(url, options);
    // The upgrade response carries the socket `ws` then writes every frame to —
    // the one public handle on it. `send` before this throws in `ws` anyway.
    this.once("upgrade", (res) => {
      this.#cork = createTickCorker(res.socket);
    });
  }

  override send(data: WsSendData, cb?: WsSendCallback): void;
  override send(data: WsSendData, options: WsSendOptions, cb?: WsSendCallback): void;
  override send(
    data: WsSendData,
    optionsOrCb?: WsSendOptions | WsSendCallback,
    cb?: WsSendCallback,
  ): void {
    this.#cork?.();
    if (typeof optionsOrCb === "function") super.send(data, optionsOrCb);
    else super.send(data, optionsOrCb ?? {}, cb);
  }
}

type WsSendData = Parameters<WsWebSocket["send"]>[0];
type WsSendOptions = { mask?: boolean; binary?: boolean; compress?: boolean; fin?: boolean };
type WsSendCallback = (err?: Error) => void;

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
 * `platform/socket.ts` is the caller: its peer refuses a frame over
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
  return new CoalescingWebSocket(url, {
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
  // A deferred rather than a listener on the socket itself, because the
  // consumers own the socket listeners — they construct the rejection Errors
  // and read `isOpening()` synchronously *during* the close/error dispatch,
  // before any promise settlement could be observed. `settled` is what makes
  // the first settlement win; the resolvers themselves ignore a second call
  // only silently, which is not a state the consumers can read.
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  let settled = false;
  // The connect rejection is always consumed by the caller's `await`, but if it
  // fails before that await is reached Node would report an unhandled rejection.
  promise.catch(() => undefined);
  return {
    promise,
    markOpen(): void {
      if (settled) return;
      settled = true;
      resolve();
    },
    isOpening: () => !settled,
    fail(err: Error): void {
      if (settled) return;
      settled = true;
      reject(err);
    },
  };
}
