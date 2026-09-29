// Copyright 2025 the AAI authors. MIT license.
/**
 * WebSocket session handler — the socket ADAPTER over `session-attach.ts`.
 *
 * The session lifecycle itself (claim, resume eviction, start deadline,
 * pre-ready buffering, failure reporting, end-of-session cleanup) is
 * transport-neutral and lives in {@link attachSession}. What is left here is
 * what only a socket has: frames to parse, a keepalive ping, close codes, and
 * the `bufferedAmount` stalled-link guard (in `ws-client-sink.ts`).
 *
 * Audio validation is handled at the host transport layer (see server.ts).
 */

import type { SessionCall } from "@alexkroman1/aai";
import {
  LOG_PREVIEW_CHARS,
  SESSION_KEEPALIVE_INTERVAL_MS,
  setSessionCall,
  setSessionClient,
  setSessionLocation,
  setSessionPhone,
} from "@alexkroman1/aai/host-internal";
import { WS_OPEN } from "@alexkroman1/aai/internal";
import { errorMessage, omitUndefined, safeJsonParse } from "@alexkroman1/aai/utils";

import type { Logger } from "./runtime-config.ts";
import { consoleLogger } from "./runtime-config.ts";
import {
  type AttachedSession,
  type AttachSessionOptions,
  attachSession,
} from "./session-attach.ts";
import { createClientSink } from "./ws-client-sink.ts";
import type { SessionWebSocket } from "./ws-frames.ts";

export { asSessionWebSocket, type SessionWebSocket, safeSend } from "./ws-frames.ts";

/**
 * Options for wiring a WebSocket to a session: everything {@link attachSession}
 * takes (the socket adapter supplies `closeAfterFailure` itself), plus what only
 * a socket has.
 */
type WsSessionOptions = Omit<AttachSessionOptions, "closeAfterFailure"> & {
  /** Callback invoked when the WebSocket connection opens. */
  onOpen?: () => void;
  /** Callback invoked when the WebSocket connection closes. */
  onClose?: () => void;
  /**
   * Audio pacing lead for this connection. Defaults to
   * `CLIENT_AUDIO_LEAD_MS`, which suits a client that plays the reply in
   * real time; pass `UNPACED_AUDIO_LEAD_MS` for a programmatic client
   * that meters playback itself.
   */
  audioLeadMs?: number;
  /**
   * Keepalive ping interval in ms. Defaults to
   * `SESSION_KEEPALIVE_INTERVAL_MS`; exposed so tests can drive it on a
   * short clock rather than waiting out the real interval.
   */
  keepaliveIntervalMs?: number;
  /**
   * Where the client says it is (`?location=`), recorded under the session's
   * id for the location-aware builtins. An address: PII, never logged.
   */
  clientLocation?: string;
  /** The device's id (`?client=`), recorded the same way for `sessionClientId`. */
  clientId?: string;
  /** The client's number (`?phone=`, E.164), for `sessionClientPhone`. PII, never logged. */
  clientPhone?: string;
  /** The phone call (`WS /phone`'s `start` frame), for `sessionCall` and the lifecycle hooks. */
  call?: SessionCall;
};

const WS_CLOSE_INTERNAL = 1011;
/** A normal close — what a tool's `endSession(ctx)` ends a socket with. */
const WS_CLOSE_NORMAL = 1000;
/** Policy violation — what a session `sessionContext` refused is closed with. */
const WS_CLOSE_POLICY_VIOLATION = 1008;
/**
 * The longest close reason a WebSocket frame carries: 125 payload bytes, two of
 * them the code. An over-long reason makes `ws` THROW rather than truncate.
 */
const MAX_CLOSE_REASON_BYTES = 123;

/** `reason` cut to fit a close frame, on a character boundary. */
function closeReason(reason: string): string {
  let out = reason;
  while (Buffer.byteLength(out) > MAX_CLOSE_REASON_BYTES) out = out.slice(0, -1);
  return out;
}

/** Route one socket frame into the attached session: binary is audio, text is a command. */
function dispatchFrame(data: unknown, attached: AttachedSession, log: Logger, sid: string): void {
  if (data instanceof Uint8Array) {
    attached.sendAudio(data);
    return;
  }
  if (typeof data !== "string") {
    log.warn("ws: non-string, non-binary frame received; dropping", { sid });
    return;
  }
  const parsed = safeJsonParse(data);
  if (parsed === undefined) {
    log.warn("ws: invalid JSON; dropping", { sid, data: data.slice(0, LOG_PREVIEW_CHARS) });
    return;
  }
  attached.sendCommand(parsed);
}

/**
 * Attaches session lifecycle handlers to a native WebSocket using JSON text
 * frames for control messages and raw PCM16 binary frames for audio.
 *
 * Connection flow:
 * 1. WebSocket opens → server sends `session.configured` with sampleRate,
 *    ttsSampleRate and sessionId
 * 2. Client sets up audio → sends JSON AUDIO_READY frame
 *
 * There is no third step any more. A reconnecting client used to send a HISTORY
 * frame with the messages it still held, which made it the authority on the
 * agent's memory; the server restores the conversation from its own retained
 * event stream (see `runtime-session-stream.ts`).
 *
 * @internal
 */
export function wireSessionSocket(ws: SessionWebSocket, options: WsSessionOptions): void {
  const {
    onOpen: announceOpen,
    onClose,
    audioLeadMs,
    keepaliveIntervalMs,
    clientLocation,
    clientId,
    clientPhone,
    call,
    createSession,
    ...attachOptions
  } = options;
  const log = options.logger ?? consoleLogger;

  /** This socket's attached session, once the socket is open. */
  let attached: AttachedSession | null = null;
  /** Releases the audio pacer's pending timer; set when the sink is created.
   *  Without it a paced send could fire against a closed socket, and the timer
   *  would outlive the session. */
  let stopPacingCurrent: (() => void) | null = null;
  /** Keepalive ping timer, armed on open and cleared on close. */
  let keepalive: ReturnType<typeof setInterval> | null = null;

  function startKeepalive(sid: string): void {
    if (!ws.ping) return;
    keepalive = setInterval(() => {
      if (ws.readyState !== WS_OPEN) return;
      try {
        ws.ping?.();
      } catch (err) {
        // A socket closing between the readyState check and the ping is
        // routine, and this runs on a bare timer with no caller to catch for
        // it — an escaping throw would surface as an unhandled exception.
        log.debug("ws: keepalive ping failed", { sid, error: errorMessage(err) });
      }
    }, keepaliveIntervalMs ?? SESSION_KEEPALIVE_INTERVAL_MS);
    // Never let the keepalive alone hold the event loop open: without this a
    // finished CLI process would linger for the life of the socket.
    keepalive.unref?.();
  }

  function stopKeepalive(): void {
    if (keepalive === null) return;
    clearInterval(keepalive);
    keepalive = null;
  }

  function onOpen(): void {
    announceOpen?.();
    const { client, stopPacing, endAfterReply } = createClientSink(
      ws,
      log,
      options.readyConfig.ttsSampleRate,
      audioLeadMs,
    );
    stopPacingCurrent = stopPacing;
    attached = attachSession(client, {
      ...attachOptions,
      // Recorded before the session exists, so its first tool call sees them. A
      // resume without `?location=`, `?client=` or `?phone=` keeps what it reported before.
      createSession: (sid, sessionClient) => {
        if (clientLocation !== undefined) setSessionLocation(sid, clientLocation);
        if (clientId !== undefined) setSessionClient(sid, clientId);
        if (clientPhone !== undefined) setSessionPhone(sid, clientPhone);
        if (call !== undefined) setSessionCall(sid, call);
        return createSession(sid, sessionClient);
      },
      logger: log,
      closeAfterFailure: () => ws.close?.(WS_CLOSE_INTERNAL, "session start failed"),
      // For `WS /phone` the socket is the telephony bridge, whose close closes
      // the carrier's stream — i.e. hangs the call up (`telephony-bridge.ts`).
      closeAfterRefusal: (reason) => ws.close?.(WS_CLOSE_POLICY_VIOLATION, closeReason(reason)),
      closeOnEndSession: (request) =>
        endAfterReply(request, () => {
          // Off a timer once the goodbye has played, with no caller to catch
          // for it — a socket that is already gone must not become an
          // uncaughtException.
          try {
            ws.close?.(WS_CLOSE_NORMAL, "session ended by the agent");
          } catch (err) {
            log.debug("ws: close on endSession failed", { error: errorMessage(err) });
          }
        }),
    });
    startKeepalive(attached.id.slice(0, 8));
  }

  // readyState OPEN — socket already open (e.g. from ws handleUpgrade)
  if (ws.readyState === WS_OPEN) {
    onOpen();
  } else {
    ws.addEventListener("open", onOpen);
  }

  ws.addEventListener("message", (event) => {
    // Before open there is no session to buffer for; the attached session
    // decides for itself whether a frame is buffered, dispatched or dropped.
    if (attached === null) return;
    dispatchFrame(event.data, attached, log, attached.id.slice(0, 8));
  });

  ws.addEventListener("close", (ev) => {
    stopKeepalive();
    stopPacingCurrent?.();
    stopPacingCurrent = null;
    // `ev` is optional-chained because test doubles invoke close listeners
    // with no argument, and an abrupt drop carries no frame at all.
    attached?.detach(omitUndefined({ code: ev?.code, reason: ev?.reason }));
    onClose?.();
  });

  ws.addEventListener("error", (ev) => {
    const msg = typeof ev.message === "string" ? ev.message : "WebSocket error";
    log.error("WebSocket error", {
      ...(options.logContext ?? {}),
      ...omitUndefined({ sid: attached?.id.slice(0, 8) }),
      error: msg,
    });
  });
}
