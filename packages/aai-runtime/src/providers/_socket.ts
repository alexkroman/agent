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

import { DEFAULT_SESSION_START_TIMEOUT_MS } from "@alexkroman1/aai/host-internal";
import { WS_OPEN } from "@alexkroman1/aai/internal";
import { errorMessage } from "@alexkroman1/aai/utils";
import WebSocket from "ws";
import { createAudioSendGate } from "../_audio-gate.ts";
import { pcm16ToBytes } from "../_pcm.ts";
import {
  closeOnAbort,
  connectOrThrow,
  type ProviderSocket,
  type SessionShell,
  waitForOpen,
} from "./_utils.ts";
import type { SttEvents } from "./openers.ts";

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
 * How an opener constructs its socket — the seam a spec hands a fake through
 * instead of replacing the `ws` module.
 */
export type CreateProviderSocket = (
  url: string,
  options: WebSocket.ClientOptions,
) => ProviderSocket;

/** The production {@link CreateProviderSocket}: a real `ws` client. */
export const createProviderSocket: CreateProviderSocket = (url, options) =>
  new WebSocket(url, options);

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
export function createGuardedWs<S extends ProviderSocket>(
  create: () => S,
  makeConnectError: (msg: string) => Error,
  label: string,
): S {
  let socket: S;
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
export function dropSocket(ws: ProviderSocket, terminate?: () => void): void {
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
export interface OpenGuardedWsOptions<S extends ProviderSocket = ProviderSocket> {
  /** Construct the socket. A constructor throw becomes a connect error. */
  create: () => S;
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
  onOpen?: ((ws: S) => void) | undefined;
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
export async function openGuardedWs<S extends ProviderSocket>(
  opts: OpenGuardedWsOptions<S>,
): Promise<S> {
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

/**
 * Wire an open STT socket that takes raw PCM16 binary frames into its session
 * shell — socket `error`/`close` become stream errors and a hang-up closes the
 * session — and return the audio sender. Shared by the openers whose wire is
 * JSON control frames plus binary audio (Soniox, local), so the drop-while-
 * stalled gate and the closed/open checks are written once.
 */
export function wireSttPcmSocket(
  ws: ProviderSocket,
  shell: SessionShell<SttEvents>,
  signal: AbortSignal,
  label: string,
): (pcm: Int16Array) => void {
  ws.on("error", (err: Error) => shell.onSocketError(err));
  ws.on("close", (code: number) => shell.onSocketClose(code));
  closeOnAbort(signal, shell.close);
  // Drop audio frames while the provider link is stalled — mic audio is
  // real-time paced and loss-tolerant; see _audio-gate.ts.
  const audioGate = createAudioSendGate({ bufferedAmount: () => ws.bufferedAmount, label });
  return (pcm) => {
    if (shell.isClosed() || ws.readyState !== WS_OPEN) return;
    if (audioGate.shouldDrop()) return;
    ws.send(pcm16ToBytes(pcm), { binary: true });
  };
}
