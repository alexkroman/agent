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
 * ## The slot is keyed on `globalThis`
 *
 * A deployed guest holds two copies of this package: the harness's builds the
 * server (and so the inbox), the agent bundle's runs the sessions. A
 * module-level feed would sit in one copy with the events in the other — the
 * shape `metrics-sink.ts` argues — so it is a `Symbol.for` slot both resolve.
 * The last inbox built wins, which under `aai dev` is the newest server's.
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

const FEED_SLOT = Symbol.for("@alexkroman1/aai-runtime.clientEventFeed");

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
 * One frame on an `?events=1` inbox socket.
 *
 * @internal
 */
export type ClientEventFrame =
  | { type: "session_event"; sessionId: string; event: SessionEvent }
  | { type: "session_ended"; sessionId: string };

/**
 * Where a client's frames go.
 *
 * @internal
 */
export type ClientEventFeed = (clientId: string, frame: ClientEventFrame) => void;

type Slot = { [FEED_SLOT]?: ClientEventFeed };

/**
 * Publish where this process's client frames go — the inbox's `feed`.
 * `undefined` unpublishes.
 *
 * @internal
 */
export function publishClientEventFeed(feed: ClientEventFeed | undefined): void {
  if (feed === undefined) delete (globalThis as Slot)[FEED_SLOT];
  else (globalThis as Slot)[FEED_SLOT] = feed;
}

/** Hand `frame` to the feed for `sessionId`'s client, if it has one and a feed exists. */
function send(sessionId: string, frame: ClientEventFrame): void {
  const feed = (globalThis as Slot)[FEED_SLOT];
  if (!feed) return;
  const clientId = sessionClientId({ sessionId });
  if (clientId === undefined) return;
  try {
    feed(clientId, frame);
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
