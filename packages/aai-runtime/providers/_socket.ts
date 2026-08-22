// Copyright 2026 the AAI authors. MIT license.
/**
 * The raw-`ws` socket lifecycle every provider opener that speaks a WebSocket
 * protocol directly shares: construct it guarded, wait for `open` under a
 * deadline and the session's abort signal, and detach + close it without ever
 * leaving an `'error'` event unlistened.
 *
 * Split from `_utils.ts` (which stays the openers' general scaffolding — the
 * session shell, the PCM frame accumulator, credential resolution) for the
 * repo's line cap, and the split falls here because this is the one concern
 * whose whole job is a socket that must never outlive its owner.
 */

import { DEFAULT_SESSION_START_TIMEOUT_MS, WS_OPEN } from "@alexkroman1/aai/host-internal";
import { errorMessage } from "@alexkroman1/aai/utils";
import type WebSocket from "ws";
import { connectOrThrow, waitForOpen } from "./_utils.ts";

/**
 * Deadline for the INITIAL provider socket open, applied by
 * {@link openGuardedWs}.
 *
 * Every raw-`ws` open needs one, including the first: a connect that
 * black-holes (a dropped SYN, a stalled proxy — neither emits `open` nor
 * `error`) otherwise leaves `waitForOpen` pending forever, so `providers.open()`
 * never resolves and the socket is held by a listener with no owner. The
 * `ws-handler`'s `pTimeout` rejects the SESSION at
 * {@link DEFAULT_SESSION_START_TIMEOUT_MS} and says in its own comment that it
 * does NOT cancel the underlying `start()` — the session that reported the
 * failure is gone and the socket is not.
 *
 * Kept under that session budget so the failure names the provider
 * (`stt_connect_failed`/`tts_connect_failed`) rather than surfacing as the less
 * specific session-start timeout. It matches the AssemblyAI STT SDK's own
 * worst-case connect budget (`STT_CONNECT_TIMEOUT_MS` x 3 attempts plus two
 * retry delays = 8500 ms), which is the same arithmetic against the same
 * ceiling.
 *
 * @internal Exported for the connect-deadline regression specs.
 */
export const WS_OPEN_TIMEOUT_MS = 8000;

/**
 * Construct a raw provider WebSocket, wrapping a constructor throw as a connect
 * error, and bind the pre-connect zero-listener `error` guard.
 *
 * The guard matters: `waitForOpen`'s own `error` listener is removed once it
 * settles, so a later socket `error` with no listener bound is an unhandled
 * `'error'` event — an uncaughtException that crashes the multi-tenant host.
 * This is the one place that invariant now lives; openers call it instead of
 * repeating the try/catch + placeholder-listener dance.
 */
export function createGuardedWs(
  create: () => WebSocket,
  makeConnectError: (msg: string) => Error,
  label: string,
): WebSocket {
  let socket: WebSocket;
  try {
    socket = create();
  } catch (cause) {
    throw makeConnectError(`${label}: failed to create WebSocket: ${errorMessage(cause)}`);
  }
  socket.on("error", () => undefined);
  return socket;
}

/**
 * Detach and politely close a socket, leaving a fresh zero-listener `error`
 * guard behind so an `'error'` emitted while the close handshake is in flight
 * (a TCP reset, a write failure) can't crash the process. `removeAllListeners`
 * on its own strips that guard — the bug this centralizes away from the
 * openers. Pass `terminate` to send a graceful shutdown frame when still open.
 */
export function dropSocket(ws: WebSocket, terminate?: () => void): void {
  ws.removeAllListeners();
  ws.on("error", () => undefined);
  if (terminate && ws.readyState === WS_OPEN) {
    try {
      terminate();
    } catch {
      // Already going away; the close below is what matters.
    }
  }
  try {
    ws.close();
  } catch {
    // Socket already broken — nothing left to release.
  }
}
/** The whole raw-`ws` open, in one call — see {@link openGuardedWs}. */
export interface OpenGuardedWsOptions {
  /** Construct the socket. A constructor throw becomes a connect error. */
  create: () => WebSocket;
  /** Provider label prefixing every error message (e.g. `"Rime TTS"`). */
  label: string;
  /** Build the provider's connect-error variant (e.g. `tts_connect_failed`). */
  makeConnectError: (msg: string) => Error;
  /** The session's abort signal, so a hang-up abandons the connect. */
  signal: AbortSignal;
  /**
   * Run once the socket is open, still inside the guarded window — a config
   * frame that must precede any other traffic. A throw here drops the socket
   * and rejects, exactly as a failed open does.
   */
  onOpen?: ((ws: WebSocket) => void) | undefined;
}

/**
 * Open a raw provider WebSocket: construct it guarded, wait for `open` under a
 * deadline and the session's abort signal, and drop it on any failure.
 *
 * The three raw-`ws` openers copy-pasted "connect, drop it on failure, rethrow"
 * and **none of them bounded the open or wired the abort**, which is the bug
 * this exists to make unwritable. A stalled upgrade meant `waitForOpen` never
 * settled, so `providers.open()` never resolved and `closeOnAbort` — registered
 * only AFTER the connect — never ran: the session was rejected at
 * {@link DEFAULT_SESSION_START_TIMEOUT_MS} by the `ws-handler`, whose own
 * comment says it does not cancel the underlying `start()`, and the socket was
 * left held by a pending listener with no owner. The reconnect paths already
 * passed a deadline; only the initial opens did not.
 */
export async function openGuardedWs(opts: OpenGuardedWsOptions): Promise<WebSocket> {
  const ws = createGuardedWs(opts.create, opts.makeConnectError, opts.label);
  try {
    await connectOrThrow(opts.label, opts.makeConnectError, async () => {
      await waitForOpen(ws, { timeoutMs: WS_OPEN_TIMEOUT_MS, signal: opts.signal });
      opts.onOpen?.(ws);
    });
  } catch (err) {
    // Failed connect (or a failed first frame): close the socket before
    // rethrowing so it can't linger half-open — late errors land in the guard
    // listener `createGuardedWs`/`dropSocket` leave behind.
    dropSocket(ws);
    throw err;
  }
  return ws;
}
