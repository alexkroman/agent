// Copyright 2026 the AAI authors. MIT license.
/**
 * A client's LIVE conversation, for whoever holds its `/inbox` with
 * `?events=1` — the browser twin that shows what the speaker on the counter is
 * saying while it says it.
 *
 * The session emitter already has every reader that belongs to ONE session (the
 * log, the socket, the agent's hooks). This is a reader that belongs to a
 * CLIENT: every session bound to it by `?client=` (`sessionClientId`), whichever
 * socket opened it. The session side calls {@link feedClientEvent} from the
 * emitter's `observe` step (`runtime-session-controls.ts`, beside the metrics
 * sinks) and {@link feedClientSessionEnd} once a session's log is flushed
 * (`runtime-session-memory.ts`); the inbox (`client-inbox.ts`) publishes where
 * the frames go.
 *
 * ## What is forwarded, and what never is
 *
 * {@link CLIENT_FEED_EVENT_TYPES}, and nothing else: the two COMMITTED
 * transcripts (an interim caption per STT partial would be most of the
 * traffic), `tool.called` (a name and its arguments), the reply boundaries, the
 * handshake and a reset. Never `tool.completed` — a tool's RESULT can be a whole
 * web page — and never audio. A device's socket is small, and a page that
 * wants a result reads the durable transcript (`ctx.clientTranscript` in a
 * route).
 *
 * ## The slot is module-level
 *
 * The server builds the inbox and the sessions emit the events; they share this
 * module because a process holds one copy of the package (`metrics-sink.ts`
 * argues the same shape). The last inbox built wins, which under `aai dev` is
 * the newest server's.
 *
 * ## It cannot hurt a session
 *
 * Called on the emit path, synchronously, once per event: the type filter runs
 * first and an unpublished slot costs one property read. A feed that throws is
 * caught — a caption on a second screen must never take down the call.
 *
 * @internal
 */

import { type SessionEvent, sessionClientId } from "@alexkroman1/aai";
import type { InboxServerFrame } from "@alexkroman1/aai/protocol";

/** The published feed, or undefined before an inbox is built. */
let feed: ClientEventFeed | undefined;

/**
 * The event types a client's feed carries — see the module doc.
 *
 * @internal
 */
export const CLIENT_FEED_EVENT_TYPES: ReadonlySet<SessionEvent["type"]> = new Set([
  "session.configured",
  "user-transcript.committed",
  "agent-transcript.committed",
  "tool.called",
  "reply.completed",
  "reply.cancelled",
  "session.reset",
]);

/**
 * One frame on an `?events=1` inbox socket: the two live arms of the wire's
 * {@link InboxServerFrame}, with the event narrowed to what a session emits.
 *
 * @internal
 */
export type ClientEventFrame =
  | (Extract<InboxServerFrame, { type: "session_event" }> & { event: SessionEvent })
  | Extract<InboxServerFrame, { type: "session_ended" }>;

/**
 * Where a client's frames go.
 *
 * @internal
 */
export type ClientEventFeed = (clientId: string, frame: ClientEventFrame) => void;

/**
 * Publish where this process's client frames go — the inbox's `feed`.
 * `undefined` unpublishes.
 *
 * @internal
 */
export function publishClientEventFeed(next: ClientEventFeed | undefined): void {
  feed = next;
}

/** Hand `frame` to the feed for `sessionId`'s client, if it has one and a feed exists. */
function send(sessionId: string, frame: ClientEventFrame): void {
  const current = feed;
  if (!current) return;
  const clientId = sessionClientId({ sessionId });
  if (clientId === undefined) return;
  try {
    current(clientId, frame);
  } catch {
    // See the module doc: the second screen's failure is never the session's.
  }
}

/**
 * Offer one session event to its client's feed. A type outside
 * {@link CLIENT_FEED_EVENT_TYPES} is dropped before anything else is looked up.
 *
 * @internal
 */
export function feedClientEvent(sessionId: string, event: SessionEvent): void {
  if (!CLIENT_FEED_EVENT_TYPES.has(event.type)) return;
  send(sessionId, { type: "session_event", sessionId, event });
}

/**
 * Tell the session's client feed the session stopped (its log is flushed).
 *
 * @internal
 */
export function feedClientSessionEnd(sessionId: string): void {
  send(sessionId, { type: "session_ended", sessionId });
}
