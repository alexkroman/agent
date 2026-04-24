// Copyright 2025 the AAI authors. MIT license.
/**
 * WebSocket session lifecycle handler.
 *
 * Audio validation is handled at the host transport layer (see server.ts).
 */

import pTimeout from "p-timeout";
import {
  DEFAULT_SESSION_START_TIMEOUT_MS,
  MAX_MESSAGE_BUFFER_SIZE,
  WS_OPEN,
} from "../sdk/constants.ts";
import type { ClientSink } from "../sdk/protocol.ts";
import { errorDetail } from "../sdk/utils.ts";
import {
  decodeC2S,
  encAgentTranscript,
  encAudioChunkS2C,
  encAudioDone,
  encCancelled,
  encConfig,
  encCustomEvent,
  encError,
  encIdleTimeout,
  encReplyDone,
  encResetS2C,
  encSpeechStarted,
  encSpeechStopped,
  encToolCall,
  encToolCallDone,
  encUserTranscript,
} from "../sdk/wire.ts";
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
  send(data: string | ArrayBuffer | Uint8Array): void;
  addEventListener(type: "close" | "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "error", listener: (event: { message?: string }) => void): void;
};

/** Options for wiring a WebSocket to a session. */
export type WsSessionOptions = {
  /** Map of active sessions (session is added on open, removed on close). */
  sessions: Map<string, SessionCore>;
  /** Factory function to create a session for a given ID and client sink. */
  createSession: (sessionId: string, client: ClientSink) => SessionCore;
  /** Protocol config sent to the client immediately on connect. */
  readyConfig: { audioFormat: "pcm16"; sampleRate: number; ttsSampleRate: number };
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
  /** Old session ID to resume. When set, reuses this ID instead of generating a new UUID. */
  resumeFrom?: string;
};

/**
 * Creates a {@link ClientSink} backed by a plain WebSocket.
 *
 * All events are sent as tagged binary wire frames (see sdk/wire.ts).
 */
function createClientSink(ws: SessionWebSocket, log: Logger): ClientSink {
  function safeSend(data: Uint8Array): void {
    try {
      if (ws.readyState !== WS_OPEN) return;
      ws.send(data);
    } catch (err) {
      log.debug?.("safeSend: socket closed between readyState check and send", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return {
    get open() {
      return ws.readyState === WS_OPEN;
    },
    config(cfg) {
      safeSend(encConfig(cfg));
    },
    audio(chunk) {
      safeSend(encAudioChunkS2C(chunk));
    },
    audioDone() {
      safeSend(encAudioDone());
    },
    speechStarted() {
      safeSend(encSpeechStarted());
    },
    speechStopped() {
      safeSend(encSpeechStopped());
    },
    userTranscript(text) {
      safeSend(encUserTranscript(text));
    },
    agentTranscript(text) {
      safeSend(encAgentTranscript(text));
    },
    toolCall(id, name, args) {
      const frame = encToolCall(id, name, args);
      if (frame === null) {
        log.warn("tool_call: failed to serialize args", { name });
        return;
      }
      safeSend(frame);
    },
    toolCallDone(id, result) {
      safeSend(encToolCallDone(id, result));
    },
    replyDone() {
      safeSend(encReplyDone());
    },
    cancelled() {
      safeSend(encCancelled());
    },
    reset() {
      safeSend(encResetS2C());
    },
    idleTimeout() {
      safeSend(encIdleTimeout());
    },
    error(code, message) {
      safeSend(encError(code, message));
    },
    customEvent(name, data) {
      const frame = encCustomEvent(name, data);
      if (frame === null) {
        log.warn("custom_event: failed to serialize data", { name });
        return;
      }
      safeSend(frame);
    },
  };
}

/**
 * Decode a single inbound binary wire frame and dispatch to the appropriate
 * SessionCore method. Non-binary frames and decode failures are dropped with
 * a warning — the connection is never closed on a bad frame (§5.1).
 */
function handleFrame(data: unknown, session: SessionCore, log: Logger, sid: string): void {
  if (!(data instanceof Uint8Array)) {
    // Node `ws` delivers Buffer which extends Uint8Array, so this is the hot path.
    // Strings are not expected on the new protocol — drop.
    log.warn("ws: non-binary frame received; dropping", { sid });
    return;
  }
  const result = decodeC2S(data);
  if (!result.ok) {
    log.warn("ws: wire decode failed", { sid, reason: result.reason });
    return;
  }
  switch (result.data.type) {
    case "audio_chunk":
      session.onAudio(result.data.pcm);
      break;
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
    default:
      // Exhaustive — decodeC2S only returns known C2S types above.
      break;
  }
}

/**
 * Attaches session lifecycle handlers to a native WebSocket using
 * tagged binary wire frames for all messages (see sdk/wire.ts).
 *
 * Connection flow:
 * 1. WebSocket opens → server sends CONFIG binary frame with sampleRate, ttsSampleRate, sid
 * 2. Client sets up audio → sends AUDIO_READY binary frame
 * 3. If reconnecting → client sends HISTORY binary frame with prior messages
 */
export function wireSessionSocket(ws: SessionWebSocket, opts: WsSessionOptions): void {
  const { sessions, logger: log = consoleLogger } = opts;
  const sessionId = opts.resumeFrom ?? crypto.randomUUID();
  const sid = sessionId.slice(0, 8);
  const ctx = opts.logContext ?? {};

  let session: SessionCore | null = null;
  /** Set to true once session.start() resolves. Messages arriving before
   *  this flag is set are buffered and replayed once the session is ready,
   *  preventing audio/frames from being dispatched to a half-initialized session. */
  let sessionReady = false;
  let messageBuffer: { data: unknown }[] | null = [];

  function drainBuffer(): void {
    if (!(session && messageBuffer)) return;
    const buf = messageBuffer;
    messageBuffer = null;
    for (const event of buf) handleFrame(event.data, session, log, sid);
  }

  function onOpen(): void {
    opts.onOpen?.();
    log.info("Session connected", { ...ctx, sid });

    const client = createClientSink(ws, log);
    session = opts.createSession(sessionId, client);
    sessions.set(sessionId, session);
    opts.onSinkCreated?.(sessionId, client);

    // Send config immediately — zero RTT. Include sessionId (as sid) so the
    // client can reconnect with ?sessionId=<id> to resume a persisted session.
    ws.send(
      encConfig({
        sampleRate: opts.readyConfig.sampleRate,
        ttsSampleRate: opts.readyConfig.ttsSampleRate,
        sid: sessionId,
      }),
    );

    const timeoutMs = opts.sessionStartTimeoutMs ?? DEFAULT_SESSION_START_TIMEOUT_MS;
    const startWithTimeout = pTimeout(session.start(), {
      milliseconds: timeoutMs,
      message: `session.start() timed out after ${timeoutMs}ms`,
    });

    startWithTimeout
      .then(() => {
        log.info("Session ready", { ...ctx, sid });
        sessionReady = true;
        drainBuffer();
      })
      .catch((err: unknown) => {
        log.error("Session start failed", { ...ctx, sid, error: errorDetail(err) });
        sessions.delete(sessionId);
        session = null;
        messageBuffer = null;
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
      if (messageBuffer && messageBuffer.length < MAX_MESSAGE_BUFFER_SIZE) {
        messageBuffer.push(event);
      }
      return;
    }
    handleFrame(event.data, session, log, sid);
  });

  ws.addEventListener("close", () => {
    log.info("Session disconnected", { ...ctx, sid });
    if (session) {
      void session
        .stop()
        .catch((err: unknown) => {
          log.error("Session stop failed", { ...ctx, sid, error: errorDetail(err) });
        })
        .finally(() => {
          sessions.delete(sessionId);
          opts.onSessionEnd?.(sessionId);
        });
    }
    opts.onClose?.();
  });

  ws.addEventListener("error", (ev) => {
    const msg = typeof ev.message === "string" ? ev.message : "WebSocket error";
    log.error("WebSocket error", { ...ctx, sid, error: msg });
  });
}
