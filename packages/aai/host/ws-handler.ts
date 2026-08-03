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
  MAX_MESSAGE_BUFFER_SIZE,
  MAX_WS_PAYLOAD_BYTES,
  SESSION_KEEPALIVE_INTERVAL_MS,
  WS_OPEN,
} from "../sdk/constants.ts";
import type { OwnedMap } from "../sdk/owned-map.ts";
import {
  CLIENT_MESSAGE_TYPES,
  ClientMessageSchema,
  type ClientSink,
  lenientParse,
  type ReadyConfig,
} from "../sdk/protocol.ts";
import { errorDetail, errorMessage, safeJsonParse } from "../sdk/utils.ts";

import type { Logger } from "./runtime-config.ts";
import { consoleLogger } from "./runtime-config.ts";
import type { SessionCore } from "./session-core.ts";
import { createClientSink } from "./ws-client-sink.ts";
import { type SessionWebSocket, safeSend } from "./ws-frames.ts";

export { type SessionWebSocket, safeSend } from "./ws-frames.ts";

/** Options for wiring a WebSocket to a session. */
type WsSessionOptions = {
  /** Map of active sessions (claimed on open, released on close). */
  sessions: OwnedMap<string, SessionCore>;
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
  /**
   * Callback invoked with the session ID after session cleanup. `sink` is the
   * closing connection's own client sink — the identity token consumers need
   * to distinguish this teardown from a resumed session now live under the
   * same id (compare against the sink the latest `onSinkCreated` delivered).
   */
  onSessionEnd?: (sessionId: string, sink?: ClientSink) => void;
  /** Callback invoked with the session ID and client sink after session setup. */
  onSinkCreated?: (sessionId: string, sink: ClientSink) => void;
  /** Logger instance. Defaults to console. */
  logger?: Logger;
  /**
   * Audio pacing lead for this connection. Defaults to
   * `CLIENT_AUDIO_LEAD_MS`, which suits a client that plays the reply in
   * real time; pass `UNPACED_AUDIO_LEAD_MS` for a programmatic client
   * that meters playback itself.
   */
  audioLeadMs?: number;
  /** Timeout in ms for session.start(). Defaults to 10 000 (10s). */
  sessionStartTimeoutMs?: number;
  /**
   * Keepalive ping interval in ms. Defaults to
   * `SESSION_KEEPALIVE_INTERVAL_MS`; exposed so tests can drive it on a
   * short clock rather than waiting out the real interval.
   */
  keepaliveIntervalMs?: number;
  /** Old session ID to resume. When set, reuses this ID instead of generating a new UUID. */
  resumeFrom?: string;
};

const WS_CLOSE_INTERNAL = 1011;

/**
 * Sink per live session, so a resume takeover (a new connection presenting an
 * id whose previous session is still registered) can close the superseded
 * connection. Weak: entries die with their sessions.
 */
const sinkBySession = new WeakMap<SessionCore, ClientSink>();

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
 *
 * @internal
 */
export function wireSessionSocket(ws: SessionWebSocket, opts: WsSessionOptions): void {
  const { sessions, logger: log = consoleLogger } = opts;
  const sessionId = opts.resumeFrom ?? crypto.randomUUID();
  const sid = sessionId.slice(0, 8);
  const ctx = opts.logContext ?? {};

  let session: SessionCore | null = null;
  /** Release for this socket's claim on `sessions[sessionId]` — a no-op once
   *  a reconnect with ?sessionId=<same id> (resumeFrom) re-claims the key
   *  while the old session's async stop() drains (see endSession). */
  let releaseSessionEntry: (() => boolean) | null = null;
  /** This connection's client sink — the identity token passed to onSessionEnd. */
  let clientSink: ClientSink | null = null;
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
   *  the message-count cap — see bufferMessage). */
  let bufferedBinaryBytes = 0;
  /** JSON (non-binary) messages currently held in `messageBuffer`. */
  let bufferedJsonCount = 0;

  /**
   * Buffer one pre-ready message. Binary frames budget by bytes (mic audio
   * arriving before session.start() resolves); JSON messages keep the small
   * count cap. Drops are logged — silent loss here cost a long debug once.
   */
  function bufferMessage(event: { data: unknown }): void {
    if (!messageBuffer) return;
    const size = event.data instanceof Uint8Array ? event.data.byteLength : 0;
    const overBudget =
      size > 0
        ? bufferedBinaryBytes + size > MAX_WS_PAYLOAD_BYTES
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
        // Release by claim, not key: stop() is async, and a reconnect with
        // ?sessionId=<same id> (resumeFrom) can claim a NEW session under
        // this key while the old one drains — a key delete here would evict
        // the resumed session's entry and leak it past runtime.shutdown().
        releaseSessionEntry?.();
        opts.onSessionEnd?.(sessionId, clientSink ?? undefined);
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

    const { client, stopPacing } = createClientSink(
      ws,
      log,
      opts.readyConfig.ttsSampleRate,
      opts.audioLeadMs,
    );
    clientSink = client;
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
    // One id, one live session. The resume path (`?sessionId=<id>`) is meant
    // for the post-disconnect grace window, but a fast client reconnect can
    // land before the server has seen the old socket close — and a replayed
    // id can land at any time. Left running, the previous session would share
    // this id's tool state concurrently, keep its provider socket open past
    // runtime.shutdown() (the claim replacement orphans it from shutdown's
    // iteration), and stream into a client that no longer owns the id. Evict
    // it: stop it directly (its own close handler may never fire if its
    // socket is already dead) and close its socket so its client gets a real
    // signal. All cleanup on the old connection releases by claim, so its
    // late teardown cannot touch the entries registered below.
    const superseded = sessions.get(sessionId);
    releaseSessionEntry = sessions.claim(sessionId, session);
    sinkBySession.set(session, client);
    opts.onSinkCreated?.(sessionId, client);
    if (superseded && superseded !== session) {
      log.warn("ws: session id already live; evicting the superseded session", { ...ctx, sid });
      sinkBySession.get(superseded)?.close?.("session resumed by another connection");
      void superseded.stop().catch((err: unknown) => {
        log.warn("ws: superseded session stop failed", { ...ctx, sid, error: errorMessage(err) });
      });
    }

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
