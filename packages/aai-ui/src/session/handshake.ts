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
 *
 * The deadline itself is the `awaitingHandshake` state's `after` delay in
 * `session/connection.ts`, so leaving the state — a `config` frame, a close, a
 * teardown — is what disarms it. This module holds its numbers and its error.
 */

import type { SessionError } from "../types.ts";

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
export const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * How many consecutive handshake timeouts to ride out before giving up.
 *
 * `forceReconnect` restarts partysocket's own retry budget, so this is the
 * budget for this failure mode — without one, a permanently wedged peer would
 * be re-dialed every ~10s forever, which is the unbounded retry loop
 * `RECONNECT_OPTIONS.maxRetries` exists to prevent.
 *
 * CONSECUTIVE is the whole of it: only a completed handshake resets the count.
 * One `connect()` spans partysocket's retries, so a count that survived a
 * successful session in between turned an hour-long call whose socket dropped
 * three times — each drop timing out once before the next attempt succeeded —
 * into the permanent "did not complete the session handshake" error against a
 * peer that had answered every time. A close must NOT reset it: a wedged peer
 * closes and reopens on its own, and resetting there is the unbounded re-dial
 * loop the budget exists to bound.
 */
export const MAX_HANDSHAKE_TIMEOUTS = 3;
