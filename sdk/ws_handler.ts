// Copyright 2025 the AAI authors. MIT license.
/**
 * WebSocket session lifecycle handler.
 *
 * Cross-runtime: accepts a Logger parameter instead of importing `@std/log`.
 * Audio validation is inlined (no dependency on server-side schemas).
 *
 * @module
 */

import type { ClientMessage, ClientSink, ReadyConfig } from "./protocol.ts";
import { ClientMessageSchema } from "./protocol.ts";
import type { Logger } from "./runtime.ts";
import { consoleLogger } from "./runtime.ts";
import type { Session } from "./session.ts";

/**
 * Minimal WebSocket interface accepted by {@linkcode wireSessionSocket}.
 *
 * Satisfied by the standard `WebSocket`, `BridgedWebSocket` (capnweb),
 * and the `ws` npm package's WebSocket.
 */
export type SessionWebSocket = {
  readonly readyState: number;
  send(data: string | ArrayBuffer | Uint8Array): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
};

/** Max size for a single audio chunk from the browser (1 MB). */
const MAX_AUDIO_CHUNK_BYTES = 1_048_576;

/** Validate a PCM16 audio chunk: non-empty, within size bounds, even byte length. */
function isValidAudioChunk(data: Uint8Array): boolean {
  return (
    data.byteLength > 0 && data.byteLength <= MAX_AUDIO_CHUNK_BYTES && data.byteLength % 2 === 0
  );
}

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
 * Creates a {@linkcode ClientSink} backed by a plain WebSocket.
 *
 * Text events are sent as JSON text frames; audio chunks are sent as
 * binary frames (zero-copy).
 */
function createClientSink(ws: SessionWebSocket): ClientSink {
  return {
    get open() {
      return ws.readyState === 1;
    },
    event(e) {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify(e));
      }
    },
    playAudioChunk(chunk) {
      if (ws.readyState === 1) {
        ws.send(chunk);
      }
    },
    playAudioDone() {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "audio_done" }));
      }
    },
  };
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

  function onOpen(): void {
    opts.onOpen?.();
    log.info("Session connected", { ...ctx, sid });

    const client = createClientSink(ws);
    session = opts.createSession(sessionId, client);
    sessions.set(sessionId, session);

    // Send config immediately — zero RTT
    ws.send(JSON.stringify({ type: "config", ...opts.readyConfig }));

    void session.start();
    log.info("Session ready", { ...ctx, sid });
  }

  // readyState 1 = OPEN — socket already open (e.g. from ws handleUpgrade)
  if (ws.readyState === 1) {
    onOpen();
  } else {
    ws.addEventListener("open", onOpen);
  }

  ws.addEventListener("message", (event: Event) => {
    if (!session) return;
    const msgEvent = event as MessageEvent;
    const { data } = msgEvent;

    // Binary frame → raw PCM16 audio
    // Node's ws package delivers Buffer; Deno/browsers deliver ArrayBuffer
    const isBinary =
      (globalThis as { Buffer?: { isBuffer(v: unknown): boolean } }).Buffer?.isBuffer(data) ||
      data instanceof ArrayBuffer ||
      data instanceof Uint8Array;
    if (isBinary) {
      const chunk =
        data instanceof Uint8Array
          ? data
          : new Uint8Array(
              data.buffer ?? data,
              data.byteOffset ?? 0,
              data.byteLength ?? data.byteLength,
            );
      if (!isValidAudioChunk(chunk)) {
        log.warn("Invalid audio chunk, dropping", {
          ...ctx,
          sid,
          bytes: chunk.byteLength,
          aligned: chunk.byteLength % 2 === 0,
        });
        return;
      }
      session.onAudio(chunk);
      return;
    }

    // Text frame → JSON message
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
      log.warn("Invalid client message", {
        ...ctx,
        sid,
        error: parsed.error.message,
      });
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
    }
  });

  ws.addEventListener("close", () => {
    log.info("Session disconnected", { ...ctx, sid });
    if (session) {
      void session.stop().finally(() => {
        sessions.delete(sessionId);
      });
    }
    opts.onClose?.();
  });

  ws.addEventListener("error", (event) => {
    const msg = event instanceof ErrorEvent ? event.message : "WebSocket error";
    log.error("WebSocket error", { ...ctx, sid, error: msg });
  });
}
