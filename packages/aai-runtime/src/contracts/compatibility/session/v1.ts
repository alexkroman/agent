// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring template: `aai-runtime:session` epoch 1.
 *
 * What a HOST does with a session it did not build — the handle a transport
 * drives (`ServerSession`), the socket it is started on (`SessionWebSocket`),
 * the retained stream it reads back (`SessionEventStream`, `SessionEventPage`,
 * `StoredSessionEvent`), the state-sync seam (`StateSyncSession`) and the two
 * types a custom transport reports in (`TransportEventBody`,
 * `TransportEventType`) — written the way a host authored it at epoch 1. It
 * must keep compiling for as long as epoch 1 is advertised as supported.
 *
 * ## What moved, and why epoch 1 survives it
 *
 * `TransportEventBody` and `TransportEventType` each gained one member,
 * `"user-turn.exceeded"` — the event the pipeline transport reports when
 * `AgentDef.userTurnLimit` cuts a caller's turn. A union that GREW: every
 * event an epoch-1 transport reported is still a member, so `report()` below
 * compiles unchanged, and a reader that switches over `TransportEventType`
 * with a `default` arm is unaffected. A reader that switched EXHAUSTIVELY
 * would have gained an unhandled arm, which is the one shape an added member
 * can break; this file does not write one, because an epoch-1 host that did
 * would have to be told rather than kept compiling. If a later epoch removes a
 * member this file reports, or changes what a page or a stored event carries,
 * this file reddens — the signal to DROP the epoch rather than to edit it.
 *
 * Relative specifiers, as every frozen example: the package's own `exports`
 * map would resolve to the CURRENT build, which is the wrong thing to prove.
 *
 * @module
 */

import {
  SESSION_EVENTS_TOKEN_ENV,
  type ServerSession,
  type SessionEventPage,
  type SessionEventStream,
  type SessionWebSocket,
  type StateSyncSession,
  type StoredSessionEvent,
  type TransportEventBody,
  type TransportEventType,
} from "../../../runtime-barrel.ts";

/** The env var a host reads the session-events bearer token from. */
export const tokenEnv: string = SESSION_EVENTS_TOKEN_ENV;

/**
 * ── A custom TRANSPORT reports in the protocol's own vocabulary. ────────
 *
 * Epoch 1's two members: the caller's committed words, and the reply the
 * provider finished. Both are still members after epoch 2.
 */
export function reportCommitted(session: ServerSession, text: string): void {
  const event: TransportEventBody = { type: "user-transcript.committed", text };
  session.report(event);
}

export function reportReplyDone(session: ServerSession): void {
  session.report({ type: "reply.completed" });
}

/** The names a host's own recorder keys on, at epoch 1. */
export const RECORDED: readonly TransportEventType[] = [
  "speech.started",
  "speech.stopped",
  "user-transcript.committed",
  "reply.completed",
];

/** ── The socket a session is started on: what a host's adapter has to look like. ── */
export function isOpen(ws: SessionWebSocket): boolean {
  return ws.readyState === 1;
}

/**
 * ── Reading the retained stream back: the last fifty events of a session. ──
 *
 * `tail` is the next index to be written, so the page ending there is the
 * most recent one.
 */
export async function lastPage(
  stream: SessionEventStream,
  sessionId: string,
): Promise<SessionEventPage> {
  const tail = stream.tail(sessionId);
  return await stream.read(sessionId, Math.max(0, tail - 50), 50);
}

/** What a durable store holds per event: its index and the stamped JSON. */
export function toStored(index: number, json: string): StoredSessionEvent {
  return { index, json };
}

/** ── The state-sync seam: push a projection only when it changed. ──────── */
export function pushIfChanged(session: StateSyncSession, json: string): boolean {
  if (session.lastPush() === json) return false;
  session.recordPush(json);
  return true;
}
