// Copyright 2025 the AAI authors. MIT license.
/**
 * WebSocket session lifecycle handler.
 *
 * Audio validation is handled at the host transport layer (see server.ts).
 */

import type { OwnedMap } from "@alexkroman1/aai/host-internal";
import {
  DEFAULT_SESSION_START_TIMEOUT_MS,
  LOG_PREVIEW_CHARS,
  MAX_MESSAGE_BUFFER_SIZE,
  MAX_WS_PAYLOAD_BYTES,
  SESSION_KEEPALIVE_INTERVAL_MS,
  WS_OPEN,
} from "@alexkroman1/aai/host-internal";
import {
  type ClientSink,
  lenientParse,
  type ReadyConfig,
  SESSION_COMMAND_TYPES,
  SessionCommandSchema,
} from "@alexkroman1/aai/protocol";
import { errorDetail, errorMessage, safeJsonParse } from "@alexkroman1/aai/utils";
import pTimeout from "p-timeout";

import type { Logger } from "./runtime-config.ts";
import { consoleLogger } from "./runtime-config.ts";
import type { ServerSession } from "./session-core.ts";
import { stampSessionEvent } from "./session-event-stream.ts";
import { createClientSink } from "./ws-client-sink.ts";
import type { SessionWebSocket } from "./ws-frames.ts";
import { createWsSessionLifecycle } from "./ws-session-lifecycle.ts";

export { asSessionWebSocket, type SessionWebSocket, safeSend } from "./ws-frames.ts";

/** Options for wiring a WebSocket to a session. */
type WsSessionOptions = {
  /** Map of active sessions (claimed on open, released on close). */
  sessions: OwnedMap<string, ServerSession>;
  /** Factory function to create a session for a given ID and client sink. */
  createSession: (sessionId: string, client: ClientSink) => ServerSession;
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
const sinkBySession = new WeakMap<ServerSession, ClientSink>();

function dispatchMessage(data: unknown, session: ServerSession, log: Logger, sid: string): void {
  if (data instanceof Uint8Array) {
    // A zero-length frame carries no samples, so it is not audio, and
    // treating it as audio was wrong twice over. It went to the transport,
    // where the S2S service answers a protocol error the client then sees as
    // `internal: Missing 'audio' field`; and it re-armed the idle timer, so a
    // client sending empty frames on a timer held a session — and with it the
    // guest's session count, and so its whole sandbox — open indefinitely at
    // no bandwidth cost. Dropped silently: the rate is client-controlled, so
    // logging one line per frame would just move the abuse into the log.
    if (data.byteLength === 0) return;
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
  const result = lenientParse(SessionCommandSchema, parsed, SESSION_COMMAND_TYPES);
  if (!result.ok) {
    if (result.malformed) {
      log.warn("ws: malformed client message", { sid, error: result.error });
    }
    return;
  }
  // Handed over whole. This was a switch picking one of five session methods
  // named after the five commands, which is a translation table between a
  // vocabulary and itself — see `session-core.ts`'s module doc.
  session.command(result.data);
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
export function wireSessionSocket(ws: SessionWebSocket, opts: WsSessionOptions): void {
  const { sessions, logger: log = consoleLogger } = opts;
  const sessionId = opts.resumeFrom ?? crypto.randomUUID();
  const sid = sessionId.slice(0, 8);
  const ctx = opts.logContext ?? {};

  /**
   * This socket's session, once built.
   *
   * A plain handle now: it used to double as the phase, meaning "not created
   * yet", "the close handler already ran" and "start() failed" depending on
   * where it was read. `lifecycle` below answers that question instead.
   */
  let session: ServerSession | null = null;
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
  /**
   * Frames that arrived before the session was ready.
   *
   * Owned here rather than in the machine, like the socket in the two
   * transport lifecycles: WHEN it is replayed or discarded is a phase, and the
   * byte accounting a budget needs is not. `starting` is the only phase in
   * which it is written — see `lifecycle.buffering()`.
   */
  let messageBuffer: { data: unknown }[] = [];
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
  function dispatchSafely(data: unknown, s: ServerSession): void {
    try {
      dispatchMessage(data, s, log, sid);
    } catch (err) {
      log.error("ws: message dispatch failed", { ...ctx, sid, error: errorDetail(err) });
    }
  }

  /** Replay the pre-ready frames. `ready`'s entry action; runs exactly once. */
  function drainBuffer(): void {
    const buf = messageBuffer;
    messageBuffer = [];
    if (!session) return;
    for (const event of buf) {
      dispatchSafely(event.data, session);
    }
  }

  /** Stop a session and run end-of-session cleanup exactly once. */
  function endSession(s: ServerSession): void {
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
    // Stamped here rather than emitted: this is the path where the session could
    // not be BUILT, so there is no emitter and nothing to record the event in.
    client.event(
      stampSessionEvent({ type: "error.reported", code: "internal", message, fatal: true }),
    );
    try {
      ws.close?.(WS_CLOSE_INTERNAL, "session start failed");
    } catch (err) {
      log.debug("ws: close after start failure failed", { error: errorMessage(err) });
    }
  }

  /**
   * Where this socket's session is: connecting, starting (buffering), ready, or
   * ended. Every effect below is a HOW the machine does not know; the machine
   * owns WHEN, and in particular owns the fact that `endSession` runs once.
   */
  const lifecycle = createWsSessionLifecycle({
    start: () => {
      const timeoutMs = opts.sessionStartTimeoutMs ?? DEFAULT_SESSION_START_TIMEOUT_MS;
      // `p-timeout` rather than anything of the machine's: a rejection is what
      // `starting` is prepared for. Note it does NOT cancel the `start()`
      // underneath, which is why `endSession` runs on that arm.
      if (session === null) return Promise.resolve();
      return pTimeout(session.start(), {
        milliseconds: timeoutMs,
        message: `session.start() timed out after ${timeoutMs}ms`,
      }).catch((err: unknown) => {
        // Logged HERE rather than on the machine's `onError`, because a start
        // that fails after the client hung up has already left `starting` — so
        // the transition never fires, and this line is the only evidence a
        // provider connect black-holed. Re-thrown so the machine still reacts
        // when it IS still listening.
        log.error("Session start failed", { ...ctx, sid, error: errorDetail(err) });
        throw err;
      });
    },
    announceReady: () => {
      // `start()` resolving is not the same question as "this session works".
      // A provider that cannot open at all reports a fatal error and lets the
      // transport start anyway, so production logged `session error (fatal)`
      // for a missing TTS key and `Session ready` 400ms later — a session that
      // could never speak, announced as ready, with the two lines in the order
      // that makes the second one look like the outcome.
      //
      // The session still starts (see `ServerSession.faultCode`: the transport
      // owns that policy, not this log line). What changes is that the line
      // stops claiming otherwise, and names the code so the pair reads as one
      // event.
      const fault = session?.faultCode;
      if (fault === undefined) log.info("Session ready", { ...ctx, sid });
      else log.warn("Session ready after a fatal error", { ...ctx, sid, code: fault });
    },
    drainBuffer,
    dropBuffer: () => {
      messageBuffer = [];
    },
    endSession: () => {
      if (session) endSession(session);
    },
    failClient: () => {
      // The client received `config` and believes the session is live; tell it
      // the start failed and close, or it streams audio into a dead session
      // forever with no retry signal.
      if (clientSink) failClientAndClose(clientSink, "Session failed to start");
    },
  });

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
      lifecycle.send({ type: "CREATE_FAILED" });
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

    // Announce the session immediately — zero RTT. The frame carries the session
    // id, so the client can reconnect with ?sessionId=<id> to resume; the session
    // owns the send because the frame is an ordinary recorded event now (see
    // `ServerSession.configure`).
    session.configure(opts.readyConfig);

    // Every branch the continuation used to carry is a transition now: the
    // ready log and the buffer drain, the teardown on a rejected or timed-out
    // start, and the `if (!session) return` staleness guard, which is deleted
    // rather than trusted — a close leaves `starting`, which stops the actor.
    lifecycle.send({ type: "CREATED" });
  }

  // readyState OPEN — socket already open (e.g. from ws handleUpgrade)
  if (ws.readyState === WS_OPEN) {
    onOpen();
  } else {
    ws.addEventListener("open", onOpen);
  }

  ws.addEventListener("message", (event) => {
    // Three answers, one per phase, where this used to be a null check and a
    // boolean: buffer while `start()` is in flight so nothing reaches a session
    // whose transport connection isn't established yet, dispatch once ready,
    // and drop before a session exists or after it is over.
    if (lifecycle.buffering()) {
      bufferMessage(event);
      return;
    }
    if (!(lifecycle.dispatches() && session)) return;
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
    // A close in `starting` stops the invoked `start()`, so its resolution can
    // no longer mark a stopped session ready or drain frames into it — the
    // nulling that used to enforce that is gone. `endSession` runs on this
    // transition out of `starting` and `ready`, and on neither of the others.
    lifecycle.send({ type: "SOCKET_CLOSED" });
    opts.onClose?.();
  });

  ws.addEventListener("error", (ev) => {
    const msg = typeof ev.message === "string" ? ev.message : "WebSocket error";
    log.error("WebSocket error", { ...ctx, sid, error: msg });
  });
}
