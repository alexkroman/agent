// Copyright 2026 the AAI authors. MIT license.
/**
 * One client connection's session lifecycle, independent of what carries it.
 *
 * ## Why this is not in `ws-handler.ts` any more
 *
 * Everything below used to be the body of `wireSessionSocket`, and almost none
 * of it was about sockets: claiming the session id and evicting a superseded
 * session on a resume, announcing the session, starting it under a deadline,
 * buffering input that arrives before it is ready and replaying it after,
 * telling the client when the start failed, and running end-of-session cleanup
 * exactly once. The socket-specific part was four things — parse a frame,
 * ping on a timer, map a close code, and guard `bufferedAmount` — and because
 * they were interleaved with the rest, the only way to reach a session was to
 * BE a WebSocket. The telephony bridge pays for that today: it is a fake socket
 * that serializes every event to JSON only to regex-scan it back out.
 *
 * So the lifecycle takes a {@link ClientSink} for the output half and hands back
 * an {@link AttachedSession} for the input half. `wireSessionSocket` is now one
 * adapter over it, and `runtime.connect` is another — the one a caller with its
 * own audio I/O (a console, a WebRTC peer, a test) reaches for.
 *
 * The phase machine is still `ws-session-lifecycle.ts`; its `SOCKET_CLOSED`
 * event now means "the far end went away", whoever the far end is.
 */

import {
  DEFAULT_SESSION_START_TIMEOUT_MS,
  MAX_MESSAGE_BUFFER_SIZE,
  MAX_WS_PAYLOAD_BYTES,
} from "@alexkroman1/aai/host-internal";
import type { OwnedMap } from "@alexkroman1/aai/internal";
import {
  type ClientSink,
  lenientParse,
  type ReadyConfig,
  SESSION_COMMAND_TYPES,
  SessionCommandSchema,
} from "@alexkroman1/aai/protocol";
import { errorDetail, errorMessage } from "@alexkroman1/aai/utils";
import pTimeout from "p-timeout";
import type { Logger } from "./runtime-config.ts";
import { consoleLogger } from "./runtime-config.ts";
import type { ServerSession } from "./session-core.ts";
import { stampSessionEvent } from "./session-event-stream.ts";
import { createWsSessionLifecycle } from "./ws-session-lifecycle.ts";

/** Options for {@link attachSession}. */
export type AttachSessionOptions = {
  /** Map of active sessions (claimed on attach, released on end). */
  sessions: OwnedMap<string, ServerSession>;
  /** Factory function to create a session for a given ID and client sink. */
  createSession: (sessionId: string, client: ClientSink) => ServerSession;
  /** Protocol config announced to the client as soon as the session exists. */
  readyConfig: ReadyConfig;
  /** Additional key-value pairs included in log messages. */
  logContext?: Record<string, string>;
  /**
   * Callback invoked with the session ID after session cleanup. `sink` is the
   * ending connection's own client sink — the identity token consumers need to
   * distinguish this teardown from a resumed session now live under the same
   * id (compare against the sink the latest `onSinkCreated` delivered).
   */
  onSessionEnd?: (sessionId: string, sink?: ClientSink) => void;
  /** Callback invoked with the session ID and client sink after session setup. */
  onSinkCreated?: (sessionId: string, sink: ClientSink) => void;
  /** Logger instance. Defaults to console. */
  logger?: Logger;
  /** Timeout in ms for session.start(). Defaults to 10 000 (10s). */
  sessionStartTimeoutMs?: number;
  /** Old session ID to resume. When set, reuses this ID instead of generating a new UUID. */
  resumeFrom?: string;
  /**
   * How the far end is closed after the session failed to be built or to
   * start, once the client has been told. Defaults to `client.close`. The
   * WebSocket adapter passes its own so the close carries 1011 rather than a
   * normal-closure code.
   */
  closeAfterFailure?: () => void;
};

/** What the far end observed when it went away — for the log line only. */
export type DetachInfo = { code?: number | string; reason?: string };

/**
 * The input half of an attached session.
 *
 * Input arriving while the session is still starting is buffered and replayed
 * once it is ready; input before a session exists, or after it has ended, is
 * dropped. The caller never has to know which phase it is in.
 */
export type AttachedSession = {
  /** The session's id — a fresh UUID, or `resumeFrom`. */
  readonly id: string;
  /** One chunk of user audio: PCM16 mono at `readyConfig.sampleRate`. */
  sendAudio(bytes: Uint8Array): void;
  /**
   * One client→server command, validated against `SessionCommandSchema`
   * exactly as a socket frame is. An unknown type is ignored; a known type
   * that fails validation is logged and dropped.
   */
  sendCommand(command: unknown): void;
  /** The far end went away. Tears the session down; idempotent. */
  detach(info?: DetachInfo): void;
  /** Settles once end-of-session cleanup has run (or there was nothing to clean up). */
  readonly ended: Promise<void>;
};

type Input = { kind: "audio"; bytes: Uint8Array } | { kind: "command"; value: unknown };

/**
 * Sink per live session, so a resume takeover (a new connection presenting an
 * id whose previous session is still registered) can close the superseded
 * connection. Weak: entries die with their sessions. Module-level because the
 * superseded connection may have arrived through a different adapter.
 */
const sinkBySession = new WeakMap<ServerSession, ClientSink>();

function dispatchInput(input: Input, session: ServerSession, log: Logger, sid: string): void {
  if (input.kind === "audio") {
    // A zero-length frame carries no samples, so it is not audio, and
    // treating it as audio was wrong twice over. It went to the transport,
    // where the S2S service answers a protocol error the client then sees as
    // `internal: Missing 'audio' field`; and it re-armed the idle timer, so a
    // client sending empty frames on a timer held a session — and with it the
    // guest's session count, and so its whole sandbox — open indefinitely at
    // no bandwidth cost. Dropped silently: the rate is client-controlled, so
    // logging one line per frame would just move the abuse into the log.
    if (input.bytes.byteLength === 0) return;
    session.onAudio(input.bytes);
    return;
  }
  const result = lenientParse(SessionCommandSchema, input.value, SESSION_COMMAND_TYPES);
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
 * Create a session for `client` and run its lifecycle.
 *
 * Synchronous: by the time this returns the session exists, is claimed under
 * its id, and has announced itself to `client` (`session.configured`), and
 * `start()` is in flight. A client then sends `audio_ready` once it can play
 * audio, which is what releases the greeting.
 *
 * @internal
 */
export function attachSession(client: ClientSink, options: AttachSessionOptions): AttachedSession {
  const { sessions, logger: log = consoleLogger } = options;
  const sessionId = options.resumeFrom ?? crypto.randomUUID();
  const sid = sessionId.slice(0, 8);
  const ctx = options.logContext ?? {};

  /**
   * This connection's session, once built.
   *
   * A plain handle now: it used to double as the phase, meaning "not created
   * yet", "the close handler already ran" and "start() failed" depending on
   * where it was read. `lifecycle` below answers that question instead.
   */
  let session: ServerSession | null = null;
  /** Release for this connection's claim on `sessions[sessionId]` — a no-op
   *  once a reconnect with ?sessionId=<same id> (resumeFrom) re-claims the key
   *  while the old session's async stop() drains (see endSession). */
  let releaseSessionEntry: (() => boolean) | null = null;
  /**
   * Input that arrived before the session was ready.
   *
   * Owned here rather than in the machine: WHEN it is replayed or discarded is
   * a phase, and the byte accounting a budget needs is not. `starting` is the
   * only phase in which it is written — see `lifecycle.buffering()`.
   */
  let buffer: Input[] = [];
  /** Audio bytes currently held in `buffer` (budgeted separately from the
   *  command-count cap — see bufferInput). */
  let bufferedAudioBytes = 0;
  /** Commands currently held in `buffer`. */
  let bufferedCommandCount = 0;

  let resolveEnded: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });

  /**
   * Buffer one pre-ready input. Audio budgets by bytes (mic audio arriving
   * before session.start() resolves); commands keep the small count cap. Drops
   * are logged — silent loss here cost a long debug once.
   */
  function bufferInput(input: Input): void {
    const size = input.kind === "audio" ? input.bytes.byteLength : 0;
    const overBudget =
      size > 0
        ? bufferedAudioBytes + size > MAX_WS_PAYLOAD_BYTES
        : bufferedCommandCount >= MAX_MESSAGE_BUFFER_SIZE;
    if (overBudget) {
      log.warn("ws: pre-ready message buffer full; dropping frame", { sid });
      return;
    }
    if (size > 0) bufferedAudioBytes += size;
    else bufferedCommandCount++;
    buffer.push(input);
  }

  /**
   * dispatchInput fans out into session/transport code with no other
   * try/catch boundary; a throw escaping an adapter's event handler would be
   * an uncaughtException that takes down the host. Log-and-drop instead.
   */
  function dispatchSafely(input: Input, s: ServerSession): void {
    try {
      dispatchInput(input, s, log, sid);
    } catch (err) {
      log.error("ws: message dispatch failed", { ...ctx, sid, error: errorDetail(err) });
    }
  }

  /** Replay the pre-ready input. `ready`'s entry action; runs exactly once. */
  function drainBuffer(): void {
    const buf = buffer;
    buffer = [];
    if (!session) return;
    for (const input of buf) dispatchSafely(input, session);
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
        options.onSessionEnd?.(sessionId, client);
      })
      .catch(() => {
        /* finally callback errors are not actionable */
      })
      .finally(resolveEnded);
  }

  /**
   * Tell the client the session died and close the far end. Without this a
   * client that already received `config` keeps streaming mic audio into a
   * dead session, stuck "connecting" forever with no signal to retry.
   */
  function failClientAndClose(message: string): void {
    // Stamped here rather than emitted: this is the path where the session could
    // not be BUILT, so there is no emitter and nothing to record the event in.
    client.event(
      stampSessionEvent({ type: "error.reported", code: "internal", message, fatal: true }),
    );
    try {
      if (options.closeAfterFailure) options.closeAfterFailure();
      else client.close?.("session start failed");
    } catch (err) {
      log.debug("ws: close after start failure failed", { error: errorMessage(err) });
    }
  }

  /**
   * Where this connection's session is: connecting, starting (buffering),
   * ready, or ended. Every effect below is a HOW the machine does not know; the
   * machine owns WHEN, and in particular owns the fact that `endSession` runs
   * once.
   */
  const lifecycle = createWsSessionLifecycle({
    start: () => {
      const timeoutMs = options.sessionStartTimeoutMs ?? DEFAULT_SESSION_START_TIMEOUT_MS;
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
      buffer = [];
    },
    endSession: () => {
      if (session) endSession(session);
      else resolveEnded();
    },
    failClient: () => {
      // The client received `config` and believes the session is live; tell it
      // the start failed and close, or it streams audio into a dead session
      // forever with no retry signal.
      failClientAndClose("Session failed to start");
    },
  });

  function attach(): void {
    log.info("Session connected", { ...ctx, sid });
    // createSession runs synchronously from the adapter's open callback; a
    // throw here (e.g. buildTransport rejecting an unregistered transport kind
    // on a programmatically-built agent) would escape as an uncaughtException
    // and take down the host process.
    try {
      session = options.createSession(sessionId, client);
    } catch (err) {
      log.error("Session create failed", { ...ctx, sid, error: errorDetail(err) });
      session = null;
      lifecycle.send({ type: "CREATE_FAILED" });
      failClientAndClose("Failed to start session");
      resolveEnded();
      return;
    }
    // One id, one live session. The resume path (`?sessionId=<id>`) is meant
    // for the post-disconnect grace window, but a fast client reconnect can
    // land before the server has seen the old connection close — and a
    // replayed id can land at any time. Left running, the previous session
    // would share this id's tool state concurrently, keep its provider socket
    // open past runtime.shutdown() (the claim replacement orphans it from
    // shutdown's iteration), and stream into a client that no longer owns the
    // id. Evict it: stop it directly (its own close handler may never fire if
    // its connection is already dead) and close its sink so its client gets a
    // real signal. All cleanup on the old connection releases by claim, so its
    // late teardown cannot touch the entries registered below.
    const superseded = sessions.get(sessionId);
    releaseSessionEntry = sessions.claim(sessionId, session);
    sinkBySession.set(session, client);
    options.onSinkCreated?.(sessionId, client);
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
    session.configure(options.readyConfig);

    // Every branch the continuation used to carry is a transition now: the
    // ready log and the buffer drain, the teardown on a rejected or timed-out
    // start, and the `if (!session) return` staleness guard, which is deleted
    // rather than trusted — a close leaves `starting`, which stops the actor.
    lifecycle.send({ type: "CREATED" });
  }

  function receive(input: Input): void {
    // Three answers, one per phase, where this used to be a null check and a
    // boolean: buffer while `start()` is in flight so nothing reaches a session
    // whose transport connection isn't established yet, dispatch once ready,
    // and drop before a session exists or after it is over.
    if (lifecycle.buffering()) {
      bufferInput(input);
      return;
    }
    if (!(lifecycle.dispatches() && session)) return;
    dispatchSafely(input, session);
  }

  attach();

  /** Whether the far end has already been reported gone — `detach` is idempotent. */
  let detached = false;

  return {
    id: sessionId,
    sendAudio: (bytes) => receive({ kind: "audio", bytes }),
    sendCommand: (value) => receive({ kind: "command", value }),
    detach(info) {
      if (detached) return;
      detached = true;
      // A provider cutting its upstream socket, a proxy dropping the
      // connection, and a client hanging up all produced the same bare
      // "Session disconnected" line, which left a dead session undiagnosable
      // from the server's own logs. "none" distinguishes an abrupt drop, which
      // carries no close frame at all, from a real code — which 0 would not.
      log.info("Session disconnected", {
        ...ctx,
        sid,
        code: info?.code ?? "none",
        reason: info?.reason || "none",
      });
      // A close in `starting` stops the invoked `start()`, so its resolution can
      // no longer mark a stopped session ready or drain input into it.
      // `endSession` runs on this transition out of `starting` and `ready`, and
      // on neither of the others.
      lifecycle.send({ type: "SOCKET_CLOSED" });
    },
    ended,
  };
}
