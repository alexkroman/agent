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
import type { ClientMessage, ClientSink, ReadyConfig } from "../sdk/protocol.ts";
import { ClientMessageSchema, lenientParse } from "../sdk/protocol.ts";
import { errorDetail, errorMessage } from "../sdk/utils.ts";
import type { Logger } from "./runtime-config.ts";
import { consoleLogger } from "./runtime-config.ts";
import type { Session } from "./session.ts";

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
  sessions: Map<string, Session>;
  /** Factory function to create a session for a given ID and client sink. */
  createSession: (sessionId: string, client: ClientSink) => Session;
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
 * Text events are sent as JSON text frames; audio chunks are sent as
 * binary frames (zero-copy).
 */
function createClientSink(ws: SessionWebSocket, log: Logger): ClientSink {
  /** Send data over ws, silently dropping if the socket is not open. */
  function safeSend(data: string | ArrayBuffer | Uint8Array): void {
    try {
      if (ws.readyState !== WS_OPEN) return;
      ws.send(data);
    } catch (err) {
      log.debug?.("safeSend: socket closed between readyState check and send", {
        error: errorMessage(err),
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

function handleBinaryAudio(data: unknown, session: Session): boolean {
  // Buffer extends Uint8Array in Node, so this catches Buffer too.
  if (data instanceof Uint8Array) {
    session.onAudio(data);
    return true;
  }
  if (data instanceof ArrayBuffer) {
    session.onAudio(new Uint8Array(data));
    return true;
  }
  return false;
}

function handleTextMessage(
  data: unknown,
  session: Session,
  log: Logger,
  ctx: Record<string, string>,
  sid: string,
): void {
  if (typeof data !== "string") return;
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    log.warn("Invalid JSON from client", { ...ctx, sid });
    return;
  }

  const parsed = lenientParse(ClientMessageSchema, json);
  if (!parsed.ok) {
    if (parsed.malformed) log.warn("Invalid client message", { ...ctx, sid, error: parsed.error });
    return;
  }

  const msg: ClientMessage = parsed.data;
  switch (msg.type) {
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
      session.onHistory(msg.messages);
      break;
    default:
      break;
  }
}

/**
 * Attaches session lifecycle handlers to a native WebSocket using
 * plain JSON text frames and binary audio frames.
 *
 * Connection flow:
 * 1. WebSocket opens → server sends `{ type: "config", ...ReadyConfig }`
 * 2. Client sets up audio → sends `{ type: "audio_ready" }`
 * 3. If reconnecting → client sends `{ type: "history", messages: [...] }`
 */
export function wireSessionSocket(ws: SessionWebSocket, opts: WsSessionOptions): void {
  const { sessions, logger: log = consoleLogger } = opts;
  const sessionId = opts.resumeFrom ?? crypto.randomUUID();
  const sid = sessionId.slice(0, 8);
  const ctx = opts.logContext ?? {};

  let session: Session | null = null;
  /** Set to true once session.start() resolves. Messages arriving before
   *  this flag is set are buffered and replayed once the session is ready,
   *  preventing audio/text from being dispatched to a half-initialized session. */
  let sessionReady = false;
  let messageBuffer: { data: unknown }[] | null = [];

  function drainBuffer(): void {
    if (!(session && messageBuffer)) return;
    const buf = messageBuffer;
    messageBuffer = null;
    for (const event of buf) {
      const { data } = event;
      if (handleBinaryAudio(data, session)) continue;
      handleTextMessage(data, session, log, ctx, sid);
    }
  }

  function onOpen(): void {
    opts.onOpen?.();
    log.info("Session connected", { ...ctx, sid });

    const client = createClientSink(ws, log);
    session = opts.createSession(sessionId, client);
    sessions.set(sessionId, session);

    // Send config immediately — zero RTT. Include sessionId so the client
    // can reconnect with ?sessionId=<id> to resume a persisted session.
    ws.send(JSON.stringify({ type: "config", ...opts.readyConfig, sessionId }));

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
    // to a session whose S2S connection isn't established yet.
    if (!sessionReady) {
      if (messageBuffer && messageBuffer.length < MAX_MESSAGE_BUFFER_SIZE) {
        messageBuffer.push(event);
      }
      return;
    }
    const { data } = event;

    if (handleBinaryAudio(data, session)) return;
    handleTextMessage(data, session, log, ctx, sid);
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
