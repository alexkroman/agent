// Copyright 2025 the AAI authors. MIT license.
/**
 * WebSocket session lifecycle handler.
 *
 * Audio validation is handled at the host transport layer (see server.ts).
 */

import { errorDetail, errorMessage } from "./_utils.ts";
import type { ClientMessage, ClientSink, ReadyConfig } from "./protocol.ts";
import { ClientMessageSchema } from "./protocol.ts";
import type { Logger } from "./runtime.ts";
import { consoleLogger } from "./runtime.ts";
import type { Session } from "./session.ts";
import { tracer } from "./telemetry.ts";

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
  /** Logger instance. Defaults to console. */
  logger?: Logger;
};

/**
 * Creates a {@link ClientSink} backed by a plain WebSocket.
 *
 * Text events are sent as JSON text frames; audio chunks are sent as
 * binary frames (zero-copy).
 */
function createClientSink(ws: SessionWebSocket): ClientSink {
  /** Send data over ws, tolerating races where the socket closes between readyState check and send. */
  function safeSend(data: string | ArrayBuffer | Uint8Array): void {
    try {
      if (ws.readyState === 1) ws.send(data);
    } catch {
      /* socket closed between check and send */
    }
  }
  return {
    get open() {
      return ws.readyState === 1;
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

  const parsed = ClientMessageSchema.safeParse(json);
  if (!parsed.success) {
    log.warn("Invalid client message", { ...ctx, sid, error: parsed.error.message });
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
  const sessionId = crypto.randomUUID();
  const sid = sessionId.slice(0, 8);
  const ctx = opts.logContext ?? {};

  let session: Session | null = null;
  const sessionSpan = tracer.startSpan("ws.session", {
    attributes: { "aai.session.id": sessionId },
  });

  function onOpen(): void {
    opts.onOpen?.();
    log.info("Session connected", { ...ctx, sid });
    sessionSpan.addEvent("ws.open");

    const client = createClientSink(ws);
    session = opts.createSession(sessionId, client);
    sessions.set(sessionId, session);

    // Send config immediately — zero RTT
    ws.send(JSON.stringify({ type: "config", ...opts.readyConfig }));

    session
      .start()
      .then(() => {
        log.info("Session ready", { ...ctx, sid });
        sessionSpan.addEvent("session.ready");
      })
      .catch((err: unknown) => {
        log.error("Session start failed", { ...ctx, sid, error: errorDetail(err) });
        sessionSpan.setStatus({ code: 2, message: errorMessage(err) });
        sessions.delete(sessionId);
        session = null;
      });
  }

  // readyState 1 = OPEN — socket already open (e.g. from ws handleUpgrade)
  if (ws.readyState === 1) {
    onOpen();
  } else {
    ws.addEventListener("open", onOpen);
  }

  ws.addEventListener("message", (event) => {
    if (!session) return;
    const { data } = event;

    if (handleBinaryAudio(data, session)) return;
    handleTextMessage(data, session, log, ctx, sid);
  });

  ws.addEventListener("close", () => {
    log.info("Session disconnected", { ...ctx, sid });
    sessionSpan.addEvent("ws.close");
    sessionSpan.end();
    if (session) {
      void session
        .stop()
        .catch((err) => {
          log.error("Session stop failed", { ...ctx, sid, error: err });
        })
        .finally(() => {
          sessions.delete(sessionId);
        });
    }
    opts.onClose?.();
  });

  ws.addEventListener("error", (ev) => {
    const msg = typeof ev.message === "string" ? ev.message : "WebSocket error";
    log.error("WebSocket error", { ...ctx, sid, error: msg });
    sessionSpan.recordException(new Error(msg));
  });
}
