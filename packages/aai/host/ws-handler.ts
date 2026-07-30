// Copyright 2025 the AAI authors. MIT license.
/**
 * WebSocket session lifecycle handler.
 *
 * Audio validation is handled at the host transport layer (see server.ts).
 */

import pTimeout from "p-timeout";
import {
  DEFAULT_SESSION_START_TIMEOUT_MS,
  LOG_PREVIEW_CHARS,
  MAX_CLIENT_WS_BUFFERED_BYTES,
  MAX_MESSAGE_BUFFER_SIZE,
  MAX_SYNC_AUDIO_BYTES,
  MAX_WS_PAYLOAD_BYTES,
  SESSION_KEEPALIVE_INTERVAL_MS,
  WS_OPEN,
} from "../sdk/constants.ts";
import {
  CLIENT_MESSAGE_TYPES,
  ClientMessageSchema,
  type ClientSink,
  lenientParse,
  type ReadyConfig,
} from "../sdk/protocol.ts";
import { errorDetail, errorMessage, safeJsonParse } from "../sdk/utils.ts";
import { createAudioPacer } from "./audio-pacer.ts";
import type { Logger } from "./runtime-config.ts";
import { consoleLogger } from "./runtime-config.ts";
import type { SessionCore } from "./session-core.ts";

/**
 * Minimal WebSocket interface accepted by {@link wireSessionSocket}.
 *
 * Satisfied by the standard `WebSocket` and the `ws` npm package's WebSocket.
 */
export type SessionWebSocket = {
  readonly readyState: number;
  /**
   * Bytes queued by `send()` but not yet transmitted (standard WebSocket /
   * `ws` property). Optional so minimal test doubles remain assignable; when
   * absent, the audio backpressure guard is skipped.
   */
  readonly bufferedAmount?: number;
  send(data: string | ArrayBuffer | Uint8Array): void;
  /** Close the connection (standard WebSocket / `ws` method). */
  close?(code?: number, reason?: string): void;
  /**
   * Send a WebSocket ping frame (`ws`-only; the browser API has no equivalent).
   * Optional so test doubles and any non-`ws` socket stay assignable — when
   * absent the keepalive is skipped rather than emulated with a protocol
   * message, which would reach the client as unexpected session traffic.
   */
  ping?(): void;
  addEventListener(type: "open", listener: () => void): void;
  /**
   * Split from `"open"` so the close listener can read the frame's `code` and
   * `reason` — the only evidence of *why* a session ended. Both are optional:
   * an abrupt drop arrives with no close frame at all, and minimal test
   * doubles that invoke the listener with no argument stay assignable.
   */
  addEventListener(
    type: "close",
    listener: (event: { code?: number; reason?: string }) => void,
  ): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "error", listener: (event: { message?: string }) => void): void;
};

/** Options for wiring a WebSocket to a session. */
type WsSessionOptions = {
  /** Map of active sessions (session is added on open, removed on close). */
  sessions: Map<string, SessionCore>;
  /** Factory function to create a session for a given ID and client sink. */
  createSession: (sessionId: string, client: ClientSink) => SessionCore;
  /** Protocol config sent to the client immediately on connect. */
  readyConfig: ReadyConfig;
  /** Additional key-value pairs included in log messages. */
  logContext?: Record<string, string>;
  /** Callback invoked when the WebSocket connection opens. */
  onOpen?: () => void;
  /** Callback invoked when the WebSocket connection closes. */
  onClose?: () => void;
  /** Callback invoked with the session ID after session cleanup. */
  onSessionEnd?: (sessionId: string) => void;
  /** Callback invoked with the session ID and client sink after session setup. */
  onSinkCreated?: (sessionId: string, sink: ClientSink) => void;
  /** Logger instance. Defaults to console. */
  logger?: Logger;
  /** Timeout in ms for session.start(). Defaults to 10 000 (10s). */
  sessionStartTimeoutMs?: number;
  /**
   * Keepalive ping interval in ms. Defaults to
   * {@link SESSION_KEEPALIVE_INTERVAL_MS}; exposed so tests can drive it on a
   * short clock rather than waiting out the real interval.
   */
  keepaliveIntervalMs?: number;
  /** Old session ID to resume. When set, reuses this ID instead of generating a new UUID. */
  resumeFrom?: string;
};

const AUDIO_DONE_FRAME = JSON.stringify({
  type: "audio_done",
} satisfies { type: "audio_done" });

/** Send on a session socket, tolerating the close race between the readyState check and send. */
export function safeSend(ws: SessionWebSocket, data: string | Uint8Array, log: Logger): void {
  try {
    if (ws.readyState !== WS_OPEN) return;
    ws.send(data);
  } catch (err) {
    log.debug?.("safeSend: socket closed between readyState check and send", {
      error: errorMessage(err),
    });
  }
}

/** WebSocket close code sent when a stalled client is disconnected (policy violation). */
const WS_CLOSE_POLICY_VIOLATION = 1008;
const WS_CLOSE_INTERNAL = 1011;

/**
 * Creates a {@link ClientSink} backed by a plain WebSocket.
 *
 * Session events are sent as JSON text frames; audio chunks are sent as raw
 * PCM16 binary frames.
 *
 * Audio pacing: TTS synthesis outruns real-time playback, so audio goes out
 * through an {@link createAudioPacer} at a bounded lead rather than the instant
 * a provider frame arrives — otherwise a whole reply lands in the socket buffer
 * at once and a slow link turns that into seconds of invisible queue. The pacer
 * owns two ordering rules that follow from holding audio back: `audio_done` is
 * queued behind it (an early turn boundary truncates the reply client-side),
 * and a `cancelled`/`reset` event discards it (the client flushes its own
 * buffer on those, so held audio would arrive as an orphan fragment).
 *
 * Audio backpressure: the pacer keeps the socket buffer small in the ordinary
 * case, so `bufferedAmount` past {@link MAX_CLIENT_WS_BUFFERED_BYTES} (~87 s of
 * 24 kHz PCM16) now means a genuinely stalled link — the sink logs once and
 * closes the connection, which runs the normal session teardown. The client may
 * reconnect and resume via its sessionId. Sockets without `bufferedAmount` skip
 * the guard.
 */
function createClientSink(
  ws: SessionWebSocket,
  log: Logger,
  ttsSampleRate: number,
): { client: ClientSink; stopPacing: () => void } {
  let closedForBackpressure = false;
  const pacer = createAudioPacer({
    sendAudio: (chunk) => safeSend(ws, chunk, log),
    sendDone: () => safeSend(ws, AUDIO_DONE_FRAME, log),
    sampleRate: ttsSampleRate,
  });
  const client: ClientSink = {
    get open() {
      return ws.readyState === WS_OPEN;
    },
    event(e) {
      // Both events tell the client to drop its playback buffer, so whatever
      // this turn still has queued here is dead audio.
      if (e.type === "cancelled" || e.type === "reset") pacer.clear();
      safeSend(ws, JSON.stringify(e), log);
    },
    playAudioChunk(chunk) {
      const buffered = ws.bufferedAmount;
      if (buffered !== undefined && buffered > MAX_CLIENT_WS_BUFFERED_BYTES) {
        if (!closedForBackpressure) {
          closedForBackpressure = true;
          log.warn("ws: client audio backlog exceeded; closing stalled connection", {
            bufferedBytes: buffered,
            maxBufferedBytes: MAX_CLIENT_WS_BUFFERED_BYTES,
          });
          try {
            ws.close?.(WS_CLOSE_POLICY_VIOLATION, "audio backlog exceeded");
          } catch (err) {
            log.debug("ws: close after audio backlog failed", { error: errorMessage(err) });
          }
        }
        return;
      }
      pacer.push(chunk);
    },
    playAudioDone() {
      pacer.pushDone();
    },
  };
  return { client, stopPacing: pacer.stop };
}

function dispatchMessage(data: unknown, session: SessionCore, log: Logger, sid: string): void {
  if (data instanceof Uint8Array) {
    session.onAudio(data);
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
  const result = lenientParse(ClientMessageSchema, parsed, CLIENT_MESSAGE_TYPES);
  if (!result.ok) {
    if (result.malformed) {
      log.warn("ws: malformed client message", { sid, error: result.error });
    }
    return;
  }
  switch (result.data.type) {
    case "audio_ready":
      session.onAudioReady();
      break;
    case "cancel":
      session.onCancel();
      break;
    case "reset":
      session.onReset();
      break;
    case "history":
      session.onHistory(result.data.messages);
      break;
    case "tool_result":
      session.onToolResult(result.data.toolCallId, result.data.result, result.data.error);
      break;
    case "transcribe_file_start":
      session.onTranscribeFileStart(result.data.sampleRate, result.data.byteLength);
      break;
    case "transcribe_file_end":
      session.onTranscribeFileEnd();
      break;
    default:
      break;
  }
}

/**
 * Attaches session lifecycle handlers to a native WebSocket using JSON text
 * frames for control messages and raw PCM16 binary frames for audio.
 *
 * Connection flow:
 * 1. WebSocket opens → server sends JSON CONFIG frame with sampleRate, ttsSampleRate, sessionId
 * 2. Client sets up audio → sends JSON AUDIO_READY frame
 * 3. If reconnecting → client sends JSON HISTORY frame with prior messages
 */
export function wireSessionSocket(ws: SessionWebSocket, opts: WsSessionOptions): void {
  const { sessions, logger: log = consoleLogger } = opts;
  const sessionId = opts.resumeFrom ?? crypto.randomUUID();
  const sid = sessionId.slice(0, 8);
  const ctx = opts.logContext ?? {};

  let session: SessionCore | null = null;
  /** Releases the audio pacer's pending timer; set when the sink is created.
   *  Without it a paced send could fire against a closed socket, and the timer
   *  would outlive the session. */
  let stopPacingCurrent: (() => void) | null = null;
  /** Keepalive ping timer, armed on open and cleared on close. */
  let keepalive: ReturnType<typeof setInterval> | null = null;
  /** Set to true once session.start() resolves. Messages arriving before
   *  this flag is set are buffered and replayed once the session is ready,
   *  preventing audio/frames from being dispatched to a half-initialized session. */
  let sessionReady = false;
  let messageBuffer: { data: unknown }[] | null = [];
  /** Binary bytes currently held in `messageBuffer` (budgeted separately from
   *  the message-count cap so a whole file upload fits — see bufferMessage). */
  let bufferedBinaryBytes = 0;
  /** JSON (non-binary) messages currently held in `messageBuffer`. */
  let bufferedJsonCount = 0;

  /**
   * Buffer one pre-ready message. Binary frames budget by bytes (a complete
   * one-shot upload — up to MAX_SYNC_AUDIO_BYTES plus mic frames — must fit,
   * or a dropped frame/`transcribe_file_end` breaks the upload framing and
   * leaves the session's upload buffer absorbing mic audio); JSON messages
   * keep the small count cap. Drops are logged — silent loss here cost a
   * long debug once.
   */
  function bufferMessage(event: { data: unknown }): void {
    if (!messageBuffer) return;
    const size = event.data instanceof Uint8Array ? event.data.byteLength : 0;
    const overBudget =
      size > 0
        ? bufferedBinaryBytes + size > MAX_SYNC_AUDIO_BYTES + MAX_WS_PAYLOAD_BYTES
        : bufferedJsonCount >= MAX_MESSAGE_BUFFER_SIZE;
    if (overBudget) {
      log.warn("ws: pre-ready message buffer full; dropping frame", { sid });
      return;
    }
    if (size > 0) bufferedBinaryBytes += size;
    else bufferedJsonCount++;
    messageBuffer.push(event);
  }

  /**
   * dispatchMessage fans out into session/transport code with no other
   * try/catch boundary; a throw escaping a ws 'message' handler would be an
   * uncaughtException that takes down the host. Log-and-drop instead.
   */
  function dispatchSafely(data: unknown, s: SessionCore): void {
    try {
      dispatchMessage(data, s, log, sid);
    } catch (err) {
      log.error("ws: message dispatch failed", { ...ctx, sid, error: errorDetail(err) });
    }
  }

  function drainBuffer(): void {
    if (!(session && messageBuffer)) return;
    const buf = messageBuffer;
    messageBuffer = null;
    for (const event of buf) {
      dispatchSafely(event.data, session);
    }
  }

  /** Stop a session and run end-of-session cleanup exactly once. */
  function endSession(s: SessionCore): void {
    s.stop()
      .catch((err: unknown) => {
        log.error("Session stop failed", { ...ctx, sid, error: errorDetail(err) });
      })
      .finally(() => {
        // Delete by identity, not key: stop() is async, and a reconnect with
        // ?sessionId=<same id> (resumeFrom) can register a NEW session under
        // this key while the old one drains — a key delete here would evict
        // the resumed session's entry and leak it past runtime.shutdown().
        if (sessions.get(sessionId) === s) sessions.delete(sessionId);
        opts.onSessionEnd?.(sessionId);
      })
      .catch(() => {
        /* finally callback errors are not actionable */
      });
  }

  /**
   * Tell the client the session died and close the socket. Without this a
   * client that already received `config` keeps streaming mic audio into a
   * dead session, stuck "connecting" forever with no signal to retry.
   */
  function failClientAndClose(client: ClientSink, message: string): void {
    client.event({ type: "error", code: "internal", message });
    try {
      ws.close?.(WS_CLOSE_INTERNAL, "session start failed");
    } catch (err) {
      log.debug("ws: close after start failure failed", { error: errorMessage(err) });
    }
  }

  function startKeepalive(): void {
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
    }, opts.keepaliveIntervalMs ?? SESSION_KEEPALIVE_INTERVAL_MS);
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
    opts.onOpen?.();
    log.info("Session connected", { ...ctx, sid });
    startKeepalive();

    const { client, stopPacing } = createClientSink(ws, log, opts.readyConfig.ttsSampleRate);
    stopPacingCurrent = stopPacing;
    // createSession runs synchronously from the 'open'/handleUpgrade callback;
    // a throw here (e.g. buildTransport rejecting an unregistered transport
    // kind on a programmatically-built agent) would escape as an
    // uncaughtException and take down the host process.
    try {
      session = opts.createSession(sessionId, client);
    } catch (err) {
      log.error("Session create failed", { ...ctx, sid, error: errorDetail(err) });
      session = null;
      failClientAndClose(client, "Failed to start session");
      return;
    }
    sessions.set(sessionId, session);
    opts.onSinkCreated?.(sessionId, client);

    // Send config immediately — zero RTT. Include sessionId so the
    // client can reconnect with ?sessionId=<id> to resume a persisted session.
    safeSend(
      ws,
      JSON.stringify({
        type: "config",
        audioFormat: opts.readyConfig.audioFormat,
        sampleRate: opts.readyConfig.sampleRate,
        ttsSampleRate: opts.readyConfig.ttsSampleRate,
        // Present (false) only for text-only agents — see ReadyConfigSchema.
        ...(opts.readyConfig.audioOut === false && { audioOut: false }),
        sessionId,
      }),
      log,
    );

    const timeoutMs = opts.sessionStartTimeoutMs ?? DEFAULT_SESSION_START_TIMEOUT_MS;
    const startWithTimeout = pTimeout(session.start(), {
      milliseconds: timeoutMs,
      message: `session.start() timed out after ${timeoutMs}ms`,
    });

    startWithTimeout
      .then(() => {
        // Socket closed while start() was in flight — the session is already
        // stopped and the buffer discarded; don't mark it ready.
        if (!session) return;
        log.info("Session ready", { ...ctx, sid });
        sessionReady = true;
        drainBuffer();
      })
      .catch((err: unknown) => {
        log.error("Session start failed", { ...ctx, sid, error: errorDetail(err) });
        // pTimeout rejects but does NOT cancel the underlying start(), so the
        // transport may still be establishing (or later finish) a provider
        // connection. Tear it down and run end-of-session cleanup, otherwise
        // the close handler below sees session === null and skips both,
        // leaking the provider socket and the sink/state map entries.
        const failed = session;
        session = null;
        messageBuffer = null;
        // session === null means the close handler already ran endSession for
        // this session; its identity-guarded cleanup covers the map, and a
        // bare key delete here could evict a resumed session's entry.
        if (failed) {
          endSession(failed);
          // The client received `config` and believes the session is live; tell
          // it the start failed and close, or it streams audio into a dead
          // session forever with no retry signal.
          failClientAndClose(client, "Session failed to start");
        }
      });
  }

  // readyState OPEN — socket already open (e.g. from ws handleUpgrade)
  if (ws.readyState === WS_OPEN) {
    onOpen();
  } else {
    ws.addEventListener("open", onOpen);
  }

  ws.addEventListener("message", (event) => {
    if (!session) return;
    // Buffer messages until session.start() completes to avoid dispatching
    // to a session whose transport connection isn't established yet.
    if (!sessionReady) {
      bufferMessage(event);
      return;
    }
    dispatchSafely(event.data, session);
  });

  ws.addEventListener("close", (ev) => {
    stopKeepalive();
    stopPacingCurrent?.();
    stopPacingCurrent = null;
    // A provider cutting its upstream socket, a proxy dropping the connection,
    // and a client hanging up all produced the same bare "Session
    // disconnected" line, which left a dead session undiagnosable from the
    // server's own logs. `ev` is optional-chained because test doubles invoke
    // close listeners with no argument, and an abrupt drop carries no frame —
    // "none" distinguishes that from a real code, which 0 would not.
    log.info("Session disconnected", {
      ...ctx,
      sid,
      code: ev?.code ?? "none",
      reason: ev?.reason || "none",
    });
    // Null the session and buffer before stopping: if session.start() is
    // still in flight, its .then() would otherwise mark the stopped session
    // ready and drain buffered frames into it.
    const closed = session;
    session = null;
    messageBuffer = null;
    if (closed) endSession(closed);
    opts.onClose?.();
  });

  ws.addEventListener("error", (ev) => {
    const msg = typeof ev.message === "string" ? ev.message : "WebSocket error";
    log.error("WebSocket error", { ...ctx, sid, error: msg });
  });
}
