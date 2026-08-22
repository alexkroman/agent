// Copyright 2026 the AAI authors. MIT license.
/**
 * Epoch-1 TEMPLATE for the `aai-runtime:session` capability — the transport
 * adapter for one socket, as it was written at epoch 1. Copy the file into your
 * own carrier or gateway, edit the lines marked `←`, and leave the rest alone.
 *
 * FROZEN. It must keep compiling for as long as epoch 1 is supported, so do not
 * edit it to follow a change in this package's API: a compile error here is the
 * finding, not a chore. Changing the API means a NEW epoch with a new template
 * beside this one — never an edit to this file.
 *
 * The session you are given by `runtime.createSession(…)` is one half of a
 * conversation; the other half is a socket somebody else owns — a browser, a
 * carrier's media stream, your own gateway. This is the adapter between them,
 * front to back:
 *
 * 1. Hand the session its ready config, at zero RTT, before anything else.
 * 2. Start it, and hang up rather than hold a caller on a session that reported
 *    a fault while starting.
 * 3. Route inbound frames: binary is audio, text is a command, nothing else.
 * 4. Report what only this adapter can see — a fault on ITS socket — into the
 *    session's own event record.
 * 5. Prime a resumed session from the retained events, and checkpoint on hangup.
 *
 * Outbound audio and events do NOT come back through here: they go to the
 * `ClientSink` you passed to `createSession`. {@link canSend} is the guard that
 * sink writes behind.
 *
 * Nothing runs on import: call {@link bridgeSocket} once per accepted socket.
 */

import type { Message } from "@alexkroman1/aai";
import {
  lenientParse,
  type ReadyConfig,
  SESSION_COMMAND_TYPES,
  SessionCommandSchema,
  type SessionEvent,
} from "@alexkroman1/aai/protocol";

import type {
  SessionCore,
  SessionEventPage,
  SessionEventStream,
  SessionWebSocket,
  TransportEventBody,
  TransportEventType,
} from "../../../runtime-barrel.ts";

/** `WebSocket.OPEN`, spelled rather than imported — this is the wire's number. */
const WS_OPEN = 1;

/** Close code for "this session cannot serve you", not "you did something wrong". */
const WS_CLOSE_INTERNAL = 1011;

/** ← how many bytes you let queue on this socket before you stop writing. */
const OUTBOUND_LIMIT_BYTES = 512 * 1024;

/** How many retained events to read per page while priming a resume. */
const REPLAY_PAGE = 200;

/**
 * The only event type this adapter mints.
 *
 * Everything else in a session's record is minted by the session itself, and
 * reporting one of those from out here files a SECOND event for something
 * already recorded under another id. Add a type to this set only when your
 * socket is genuinely the thing that observed it — a carrier that does its own
 * transcription, say.
 */
const REPORTED_BY_THIS_ADAPTER: ReadonlySet<TransportEventType> = new Set(["error.reported"]);

/** What your gateway keeps per accepted socket. */
export type SocketBridge = {
  /** The session's id — the handle a resume, a log line or an admin route uses. */
  readonly sessionId: string;
  /** Speak something the caller did not ask for; `false` when they cannot be. */
  speakNow(text: string): boolean;
  /** Stop the session. Idempotent from your side; safe after the socket died. */
  close(): Promise<void>;
};

/**
 * Wire one socket to one session.
 *
 * `configure` goes FIRST, before any await: a socket that has been open for
 * seconds carrying nothing reads as a wedged peer, and the browser client arms
 * its handshake guard on exactly that frame. It is an ordinary event, so it is
 * stamped and recorded like everything else — which a JSON literal written
 * straight onto the socket could never be.
 */
export function bridgeSocket(
  core: SessionCore,
  ws: SessionWebSocket,
  config: ReadyConfig,
): SocketBridge {
  core.configure(config);

  ws.addEventListener("message", (event) => {
    dispatchFrame(core, event.data);
  });

  // SYNCHRONOUS listeners that hand their promise off themselves.
  // `addEventListener` discards what a listener returns, so an `async` one turns
  // a failed stop into an unhandled rejection — a crash, where you wanted a log
  // line.
  ws.addEventListener("close", (event) => {
    void core.stop().catch((err: unknown) => {
      console.error(`stop after close ${event.code ?? "none"}`, err);
    });
  });

  ws.addEventListener("error", (event) => {
    // Not fatal: a socket error is this adapter's problem, and the session may
    // still be resumed onto a new one. Report it so it lands in the record the
    // caller's transcript is read out of, instead of only in your logs.
    report(core, {
      type: "error.reported",
      code: "connection",
      message: event.message ?? "socket error",
      fatal: false,
    });
  });

  return {
    sessionId: core.id,
    speakNow: (text) => core.announce(text),
    close: () => core.stop(),
  };
}

/**
 * Start the session, and decide whether the caller is worth keeping on the line.
 *
 * `faultCode` answers a different question from "did `start()` resolve": a
 * provider that could not open at all reports a fatal error and lets the start
 * finish, which is how a session that can never speak gets announced as ready.
 * Check it, and hang up out loud instead.
 */
export async function startOrHangUp(core: SessionCore, ws: SessionWebSocket): Promise<boolean> {
  await core.start();
  if (core.faultCode === undefined) return true;
  ws.close?.(WS_CLOSE_INTERNAL, core.faultCode);
  return false;
}

/**
 * One inbound frame.
 *
 * Binary is user audio and text is a command; there is no third kind, and a
 * zero-length binary frame is not audio — it carries no samples, and passing it
 * on both confuses the provider and re-arms the idle timer, so a client sending
 * empty frames on a timer holds a session open for free.
 */
export function dispatchFrame(core: SessionCore, data: unknown): void {
  if (typeof data === "string") {
    dispatchCommand(core, data);
    return;
  }
  if (data instanceof Uint8Array) {
    if (data.byteLength > 0) core.onAudio(data);
    return;
  }
  if (data instanceof ArrayBuffer && data.byteLength > 0) core.onAudio(new Uint8Array(data));
}

/**
 * One text frame, forwarded WHOLE.
 *
 * Do not switch on `cmd.type` here to pick one of five session methods named
 * after the five commands — the session already does that, and a translation
 * table between a vocabulary and itself is how a new command silently goes
 * unhandled. An unparseable or unknown frame is dropped: the rate is
 * client-controlled, so a log line per frame moves the abuse into your log.
 */
export function dispatchCommand(core: SessionCore, text: string): void {
  const json = parseJson(text);
  if (json === undefined) return;
  const parsed = lenientParse(SessionCommandSchema, json, SESSION_COMMAND_TYPES);
  if (parsed.ok) core.command(parsed.data);
}

/**
 * Report something into the session's record — the one funnel, so the guard
 * cannot be bypassed by a later caller reaching for `core.report` directly.
 *
 * The body carries NO envelope: `meta` is minted once, by the session's own
 * emitter, which is also what appends the event to the retained stream.
 */
export function report(core: SessionCore, event: TransportEventBody): void {
  if (!REPORTED_BY_THIS_ADAPTER.has(event.type)) return;
  core.report(event);
}

/**
 * Whether this socket will take another write. Your `ClientSink` calls it before
 * every audio chunk.
 *
 * `bufferedAmount` is optional on the type so a minimal socket double stays
 * assignable — absence means "no opinion", so skip the ceiling rather than read
 * it as zero.
 */
export function canSend(ws: SessionWebSocket, bytes: number): boolean {
  if (ws.readyState !== WS_OPEN) return false;
  const buffered = ws.bufferedAmount;
  return buffered === undefined || buffered + bytes <= OUTBOUND_LIMIT_BYTES;
}

/**
 * Prime a resumed session with what was already said.
 *
 * `hydrate` first, always: a process that never saw this session holds nothing
 * in memory for it, and reading without hydrating returns an empty stream and
 * silently resumes a caller into a conversation with no history.
 *
 * Only the COMMITTED transcripts become history. An interim snapshot is a
 * caption, and the last snapshot of an interrupted reply is not a record of
 * anything that was said.
 */
export async function primeFromRetained(
  core: SessionCore,
  stream: SessionEventStream,
  sessionId: string,
): Promise<number> {
  await stream.hydrate(sessionId);
  const history: Message[] = [];
  let from = 0;
  for (;;) {
    const page: SessionEventPage = await stream.read(sessionId, from, REPLAY_PAGE);
    for (const event of page.events) {
      const message = messageFor(event);
      if (message !== undefined) history.push(message);
    }
    from += page.events.length;
    if (page.events.length === 0 || from >= page.tail) break;
  }
  core.restoreHistory(history);
  return from;
}

/**
 * Get this call's record onto disk at hangup.
 *
 * Recording is synchronous and PERSISTING is batched — at turn boundaries and on
 * stop — so a crash costs at most the events since the last flush. That is the
 * trade a voice turn makes to keep a database round trip out of a one-second
 * time-to-first-token budget. A non-durable stream has nowhere to flush to, and
 * says so.
 */
export async function checkpoint(stream: SessionEventStream, sessionId: string): Promise<number> {
  if (stream.durable) await stream.flush(sessionId);
  return stream.tail(sessionId);
}

/** One retained event as history, or nothing if it is not something that was said. */
function messageFor(event: SessionEvent): Message | undefined {
  if (event.type === "user-transcript.committed") return { role: "user", content: event.text };
  if (event.type === "agent-transcript.committed") {
    return { role: "assistant", content: event.text };
  }
  return undefined;
}

/** A client-supplied text frame is not a trusted JSON document. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
