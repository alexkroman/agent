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

import { LOG_PREVIEW_CHARS, SESSION_KEEPALIVE_INTERVAL_MS } from "@alexkroman1/aai/host-internal";
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
};

const WS_CLOSE_INTERNAL = 1011;

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
    const { client, stopPacing } = createClientSink(
      ws,
      log,
      options.readyConfig.ttsSampleRate,
      audioLeadMs,
    );
    stopPacingCurrent = stopPacing;
    attached = attachSession(client, {
      ...attachOptions,
      logger: log,
      closeAfterFailure: () => ws.close?.(WS_CLOSE_INTERNAL, "session start failed"),
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
