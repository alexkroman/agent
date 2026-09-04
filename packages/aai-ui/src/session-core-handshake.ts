// Copyright 2026 the AAI authors. MIT license.

/**
 * The deadline on a socket that opened but never became a session.
 *
 * A completed WebSocket handshake is not a session. The server builds the
 * session synchronously from its own upgrade callback and sends `config` at
 * zero RTT (`aai/host/ws-handler.ts`), so a socket that has been open for
 * seconds with nothing on it is not slow — its peer is not a healthy agent
 * server. That happens: a tunnel or proxy answers the `101` while the guest
 * behind it is wedged, or the host dies between accepting and building the
 * session.
 *
 * Nothing else catches it. partysocket's `connectionTimeout` covers only the
 * handshake and is cleared the moment `open` fires, so the session reached
 * `state: "ready"` — painted with the same live indicator the UI gives
 * "listening" — and stayed there permanently: no `config` means
 * `initAudioCapture` never runs, so there is no mic, no error, no retry, and
 * nothing on screen to say so. Measured against a server that accepts and
 * then says nothing: `ready` at 34ms, still `ready` and errorless when the
 * probe gave up.
 */

import { forceReconnect } from "./session-core-reconnect.ts";
import type { SessionError } from "./types.ts";

/** What the session reports once the budget below is spent. */
export const HANDSHAKE_ERROR: SessionError = {
  code: "connection",
  message: "Agent did not complete the session handshake",
  // Not fatal on the statechart's own authority: this dispatches `FAILED`,
  // whose doc records that "the `fatal` latch stays clear, so a later
  // non-error frame recovers". Only `handleErrorEvent`'s else-branch is fatal.
  fatal: false,
};

/** How long an OPEN socket may go without a `config` frame. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * How many consecutive handshake timeouts to ride out before giving up.
 *
 * `forceReconnect` restarts partysocket's own retry budget, so this is the
 * budget for this failure mode — without one, a permanently wedged peer would
 * be re-dialed every ~10s forever, which is the unbounded retry loop
 * `RECONNECT_OPTIONS.maxRetries` exists to prevent.
 *
 * CONSECUTIVE is the whole of it, and only `succeeded()` says so — see its doc.
 */
const MAX_HANDSHAKE_TIMEOUTS = 3;

export type HandshakeGuard = {
  /** Start the deadline for the attempt that just opened. */
  arm(): void;
  /** Stop it — this socket is closing, or the connection is being torn down. */
  disarm(): void;
  /**
   * The `config` frame arrived: stop the deadline AND spend nothing.
   *
   * Separate from {@link HandshakeGuard.disarm} because the budget is
   * CONSECUTIVE, and only a completed handshake proves the peer is healthy. One
   * guard covers a whole `connect()`, partysocket's retries included, so with a
   * plain disarm the count survived every successful session in between: an
   * hour-long call whose socket dropped three times, each drop timing out once
   * before the next attempt succeeded, surfaced the permanent
   * "Agent did not complete the session handshake" error against a peer that
   * had answered every time. A close must NOT reset it — a wedged peer closes
   * and reopens on its own, and resetting there is the unbounded re-dial loop
   * the budget exists to bound.
   */
  succeeded(): void;
};

/**
 * Watch one connection's handshake.
 *
 * `onRetry` fires when a timed-out attempt has been re-dialed (the sandbox
 * behind the endpoint may have been replaced, and the URL provider re-brokers
 * on the next attempt); `onExhausted` when the budget is spent, or when the
 * socket has no reconnect machinery at all (an injected `options.WebSocket`).
 *
 * @internal
 */
export function createHandshakeGuard(opts: {
  socket: unknown;
  signal: AbortSignal;
  onRetry: () => void;
  onExhausted: () => void;
}): HandshakeGuard {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timeouts = 0;

  function disarm(): void {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  }

  function fire(): void {
    timer = undefined;
    timeouts += 1;
    if (timeouts < MAX_HANDSHAKE_TIMEOUTS && forceReconnect(opts.socket)) {
      opts.onRetry();
      return;
    }
    opts.onExhausted();
  }

  // The timer is a bare setTimeout, so unlike the socket listeners it does NOT
  // come off with the signal. Teardown (an explicit disconnect, a reconnect,
  // end()) would otherwise leave it armed and it would re-dial a session the
  // user has already closed — which the "user disconnect does not reconnect"
  // spec catches.
  opts.signal.addEventListener("abort", disarm);

  return {
    arm(): void {
      // `open` fires again on every partysocket retry, so re-arm per attempt.
      disarm();
      timer = setTimeout(fire, HANDSHAKE_TIMEOUT_MS);
    },
    disarm,
    succeeded(): void {
      disarm();
      timeouts = 0;
    },
  };
}
