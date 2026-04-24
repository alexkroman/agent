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
import { ClientMessageSchema, type ClientSink, lenientParse } from "../sdk/protocol.ts";
import { errorDetail } from "../sdk/utils.ts";
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
 * Session events are sent as JSON text frames; audio chunks are sent as raw
 * PCM16 binary frames.
 */
function createClientSink(ws: SessionWebSocket, log: Logger): ClientSink {
  function safeSend(data: string | Uint8Array): void {
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
    event(e) {
      safeSend(JSON.stringify(e));
    },
    playAudioChunk(chunk) {
      safeSend(chunk);
    },
    playAudioDone() {
      safeSend(JSON.stringify({ type: "audio_done" }));
    },
  };
}

function handleBinaryAudio(data: unknown, session: SessionCore): boolean {
  if (data instanceof Uint8Array) {
    session.onAudio(data);
    return true;
  }
  return false;
}

function handleTextMessage(data: unknown, session: SessionCore, log: Logger, sid: string): void {
  if (typeof data !== "string") {
    log.warn("ws: non-string, non-binary frame received; dropping", { sid });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    log.warn("ws: invalid JSON; dropping", { sid, data: data.slice(0, 200) });
    return;
  }
  const result = lenientParse(ClientMessageSchema, parsed);
  if (!result.ok) {
    log.warn("ws: unrecognised client message", { sid, issues: result.error });
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
  /** Set to true once session.start() resolves. Messages arriving before
   *  this flag is set are buffered and replayed once the session is ready,
   *  preventing audio/frames from being dispatched to a half-initialized session. */
  let sessionReady = false;
  let messageBuffer: { data: unknown }[] | null = [];

  function drainBuffer(): void {
    if (!(session && messageBuffer)) return;
    const buf = messageBuffer;
    messageBuffer = null;
    for (const event of buf) {
      if (handleBinaryAudio(event.data, session)) continue;
      handleTextMessage(event.data, session, log, sid);
    }
  }

  function onOpen(): void {
    opts.onOpen?.();
    log.info("Session connected", { ...ctx, sid });

    const client = createClientSink(ws, log);
    session = opts.createSession(sessionId, client);
    sessions.set(sessionId, session);
    opts.onSinkCreated?.(sessionId, client);

    // Send config immediately — zero RTT. Include sessionId so the
    // client can reconnect with ?sessionId=<id> to resume a persisted session.
    ws.send(
      JSON.stringify({
        type: "config",
        audioFormat: opts.readyConfig.audioFormat,
        sampleRate: opts.readyConfig.sampleRate,
        ttsSampleRate: opts.readyConfig.ttsSampleRate,
        sessionId,
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
      if (messageBuffer && messageBuffer.length < MAX_MESSAGE_BUFFER_SIZE)
        messageBuffer.push(event);
      return;
    }
    if (handleBinaryAudio(event.data, session)) return;
    handleTextMessage(event.data, session, log, sid);
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
