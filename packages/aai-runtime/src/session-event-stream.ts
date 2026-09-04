// Copyright 2026 the AAI authors. MIT license.
/**
 * One session's event stream: retained, indexed, and replayable.
 *
 * The session protocol has always had an event vocabulary and no way to
 * subscribe to it, and the stream itself was fire-and-forget — a frame the
 * client missed was gone, which is why restoring a conversation used to depend
 * on the CLIENT pushing back whatever it still happened to hold. This is the
 * mechanism that replaces that: the server keeps the record, and a reader asks
 * for a position.
 *
 * ## The shape is the workflow stream's, deliberately
 *
 * `host/workflow-api-stream.ts` already got this right for run progress, and the
 * harder problem was on the side with the weaker mechanism. So the properties
 * are copied rather than reinvented: chunks are RETAINED with the session so a
 * read is equally a replay, `startIndex` selects a position, and a read is
 * BOUNDED by the tail at the moment it arrived rather than holding a socket
 * open. A reader re-opens from where it left off.
 *
 * ## What the index is for, and what `meta.id` is for
 *
 * The **index** is the cursor and the only authoritative one — it is assigned
 * here, synchronously, from a counter hydrated out of the store. The **id**
 * (`meta.id`) is the ingestion key: stable across every re-read of the same
 * event, so a consumer writing rows can deduplicate delivery. They are not
 * interchangeable and `sdk/protocol-events.ts` says why an id cannot be a
 * cursor.
 *
 * ## "Durably recorded" means recorded HERE, and the persist is batched
 *
 * eve's rule is that hooks run after the event is durably recorded, and taken
 * literally that would put a Postgres round trip in front of every hook — inside
 * a turn with a ~1.0s time-to-first-token budget, on a call where a tool-heavy
 * turn emits tens of control events. So the two halves are separated:
 *
 * - **Recording is synchronous.** {@link SessionEventStream.append} assigns the
 *   index and returns the stamped event before anything awaits, so ordering is
 *   deterministic, a client can be told its position immediately, and a hook
 *   never observes an event the log has not recorded.
 * - **Persisting is batched** — at turn boundaries, at
 *   {@link SESSION_EVENT_FLUSH_THRESHOLD} pending events, and on session stop.
 *
 * What that costs is precise and worth stating: a crash loses at most the events
 * since the last flush. It buys the thing a voice session cannot do without,
 * which is not paying for durability inside the turn. Same trade the slot store
 * makes by committing at the end of a tool call rather than per mutation.
 *
 * ## A throwing hook must not corrupt the stream, or end the call
 *
 * Hooks run AFTER the event is recorded and after it has gone to the client, and
 * a throw is caught and logged. eve escalates a thrown handler to a failed turn;
 * that is right for a durable workflow and wrong here — a failing audit hook
 * must not end a phone call. Non-fatal by default is the same rule `EmitError`'s
 * `fatal: false` already encodes for turn-level errors.
 */

import {
  MAX_SESSION_EVENTS,
  SESSION_EVENT_FLUSH_THRESHOLD,
  SESSION_EVENT_READ_LIMIT,
} from "@alexkroman1/aai/host-internal";
import { invariant } from "@alexkroman1/aai/internal";
import {
  EVENT_ID_PREFIX,
  type SessionEvent,
  type SessionEventBody,
  SessionEventSchema,
} from "@alexkroman1/aai/protocol";
import { errorMessage } from "@alexkroman1/aai/utils";
import { monotonicFactory } from "ulid";
import { getOrCreate } from "./_get-or-create.ts";
import type { Logger } from "./runtime-config.ts";
import type { SessionStateBackend, StoredSessionEvent } from "./session-state-store.ts";

/**
 * `monotonicFactory` rather than `ulid()`: events fire in bursts well inside one
 * millisecond (a tool call's `tool.called` and its `tool.completed` on a cached
 * result), and the plain constructor would give those two ids no order at all.
 * This makes them strictly increasing WITHIN a process.
 *
 * It does not make an id a cursor, and that is not a detail: a session resumed
 * onto a replacement process starts a fresh factory on a different clock, so the
 * guarantee stops exactly where the process does. The index continues; the ids
 * do not.
 */
const nextUlid = monotonicFactory();

/** The events after which the pending batch is written out. */
const FLUSH_AFTER: ReadonlySet<SessionEvent["type"]> = new Set([
  // Turn boundaries: the natural seam, and the point at which the caller is
  // listening rather than waiting.
  "reply.completed",
  "reply.cancelled",
  // Session boundaries. `session.reset` discards the conversation, and
  // `session.timed-out` is followed by the socket closing — the last chance.
  "session.reset",
  "session.timed-out",
  // A fatal error is the one event most worth having survived the thing that
  // caused it, so it is not left to the turn boundary that may never come.
  "error.reported",
]);

/** One live session's log position and the events not yet written out. */
type StreamEntry = {
  /** Next index to assign. Hydrated from the store, so a resume continues. */
  next: number;
  /** Recorded but not yet persisted, in index order. */
  pending: StoredSessionEvent[];
  /** True once the retention cap was reported, so it is reported once. */
  cappedReported: boolean;
};

/** One page of a stream read. */
export type SessionEventPage = {
  /** The events, from the requested index, in order. */
  events: readonly SessionEvent[];
  /**
   * The log's length when the request was answered — the position a reader
   * resumes from. Equal to `startIndex + events.length` unless the page was
   * capped, which is how a reader knows to come straight back.
   */
  tail: number;
};

/** A hook the AGENT declared, plus the name it was declared under. */
export type SessionEventHook = {
  /** The event type this runs for, or `"*"` for every event. */
  readonly type: string;
  readonly run: (event: SessionEvent) => void | Promise<void>;
};

/** The runtime's view of every session's event stream. */
export type SessionEventStream = {
  /**
   * Record one event: stamp its envelope, assign its index, and return it.
   *
   * SYNCHRONOUS by contract — see the module doc. The caller sends the returned
   * event to the client and then runs hooks, in that order.
   */
  append(sessionId: string, body: SessionEventBody): SessionEvent;
  /** The log's length: the index the next event will take. */
  tail(sessionId: string): number;
  /** Read a page from `startIndex`. Flushes first, so a read sees everything recorded. */
  read(sessionId: string, startIndex: number, limit?: number): Promise<SessionEventPage>;
  /** Write out what is pending. Never rejects; a failure is logged and retried. */
  flush(sessionId: string): Promise<void>;
  /** Learn this session's stored length, so a resume continues its log. */
  hydrate(sessionId: string): Promise<void>;
  /** Forget a session: its position, its pending events, and its stored rows. */
  discard(sessionId: string): void;
  /** Drop every in-process entry (runtime shutdown). Stored rows are left alone. */
  clear(): void;
  /** Whether a read here can outlive the process — for the resolved-mode log. */
  readonly durable: boolean;
};

/**
 * Stamp the envelope onto an emitted body.
 *
 * Exported because a few frames are sent with NO SESSION behind them and so have
 * nowhere to be recorded — a host-mode handshake rejection is the case: the
 * socket is answered and closed before any session is built. Those still need an
 * envelope, because the wire schema requires one. Everything with a session goes
 * through {@link SessionEventStream.append}, which calls this itself; a second
 * caller stamping an event the stream will also record would give one event two
 * ids, which is the one thing that makes the id useless.
 *
 * @internal
 */
export function stampSessionEvent(body: SessionEventBody, now = Date.now()): SessionEvent {
  return { ...body, meta: { id: EVENT_ID_PREFIX + nextUlid(now), at: now } };
}

/**
 * Build the stream over the same backend the slot store uses.
 *
 * @internal
 */
export function createSessionEventStream(options: {
  backend: SessionStateBackend;
  logger?: Logger | undefined;
}): SessionEventStream {
  const { backend, logger } = options;
  const sessions = new Map<string, StreamEntry>();

  const entryFor = (sessionId: string): StreamEntry =>
    getOrCreate(sessions, sessionId, () => ({ next: 0, pending: [], cappedReported: false }));

  /** Write out `entry`'s pending events, putting them back on failure. */
  async function writePending(sessionId: string, entry: StreamEntry): Promise<void> {
    const batch = entry.pending;
    if (batch.length === 0) return;
    // Emptied BEFORE the await, so an event recorded during the write stays
    // pending rather than being dropped by the reassignment below.
    entry.pending = [];
    try {
      await backend.appendEvents(sessionId, batch);
    } catch (err: unknown) {
      // Back on the front of the queue, in index order: the append is idempotent
      // by primary key, so a retry that overlaps a partial success is a no-op
      // rather than a duplicate.
      entry.pending = [...batch, ...entry.pending];
      logger?.warn?.("Session events not stored", { sessionId, error: errorMessage(err) });
    }
  }

  /** The log's length: the index the next event will take. */
  const tail = (sessionId: string): number => sessions.get(sessionId)?.next ?? 0;

  async function flush(sessionId: string): Promise<void> {
    const entry = sessions.get(sessionId);
    if (!entry) return;
    await writePending(sessionId, entry);
  }

  function append(sessionId: string, body: SessionEventBody): SessionEvent {
    const entry = entryFor(sessionId);
    const event = stampSessionEvent(body);
    const index = entry.next;
    entry.next = index + 1;
    if (index >= MAX_SESSION_EVENTS) {
      // Retention, not correctness: the client still gets every frame and the
      // index keeps advancing, so a reader is never handed a position that
      // silently means something else. Reported once per session.
      if (!entry.cappedReported) {
        entry.cappedReported = true;
        logger?.error?.("Session event retention cap reached; events no longer stored", {
          sessionId,
          cap: MAX_SESSION_EVENTS,
        });
      }
      return event;
    }
    entry.pending.push({ index, json: JSON.stringify(event) });
    if (entry.pending.length >= SESSION_EVENT_FLUSH_THRESHOLD || FLUSH_AFTER.has(event.type)) {
      // Fire-and-forget, and correct: `flush` never rejects, and the caller is an
      // emit on the audio path with nothing to await. What a lost write costs is
      // bounded and stated in the module doc.
      void flush(sessionId);
    }
    return event;
  }

  async function read(
    sessionId: string,
    startIndex: number,
    limit = SESSION_EVENT_READ_LIMIT,
  ): Promise<SessionEventPage> {
    // Flushed first, so a reader cannot be told the tail is N and then handed
    // fewer than N events because the last few were still pending.
    await flush(sessionId);
    const stored = await backend.readEvents(sessionId, Math.max(0, startIndex), limit);
    const events: SessionEvent[] = [];
    for (const row of stored) {
      // A row that will not parse is DROPPED with a warning rather than failing
      // the read. It cannot come from our own writer, and the same fail-open rule
      // the slot store applies to shape drift applies here: a reader losing one
      // event beats a reader losing the stream.
      try {
        events.push(SessionEventSchema.parse(JSON.parse(row.json)));
      } catch (err: unknown) {
        logger?.warn?.("Stored session event dropped", {
          sessionId,
          index: row.index,
          error: errorMessage(err),
        });
      }
    }
    // The tail a READ reports must come from the same place its EVENTS did.
    // `tail()` answers from the in-process map, which is right for a session
    // this process is running and WRONG for one it has never heard of: a
    // durable backend outlives the process that wrote to it, so a cold read —
    // after a restart, or from a second replica — got `0` beside a full page of
    // events. Measured on Postgres under `aai dev`: four events, `tail: 0`,
    // where the same session read on its writing process answered `tail: 4`.
    //
    // It is a CURSOR, so the disagreement is not cosmetic: a client resuming
    // from it re-reads the stream from zero, and one reading it as "how much
    // exists" calls the session empty while holding four of its events. Only a
    // durable backend can even reach this — on the memory tier the session dies
    // with the process — which is why it took a real database to see.
    //
    // The count is asked ONLY when this process has no entry, so a warm read
    // (every read of a live session) still costs no query.
    const known = sessions.get(sessionId);
    const resolved = known ? known.next : await backend.countEvents(sessionId);
    // `tail` is a CURSOR — the absolute index one past the last event that
    // exists — so a page cannot contain events the tail says are not there yet.
    // This is the bug the paragraph above describes, stated as a property
    // instead of remembered: a cold read answered `tail: 0` beside four events,
    // and a client resuming from that cursor re-reads the stream from zero.
    //
    // It holds for every backend and every read, so it is checked on every read
    // rather than in the one spec that walked to it — and it is two integer
    // comparisons on numbers this function is already holding.
    //
    // **The empty guard is not defensive, it is the definition.** A read STARTING
    // past the tail is legitimate — `startIndex` is a caller's cursor and
    // `session-events-api.ts` clamps a huge one to `MAX_SAFE_INTEGER` — and it
    // answers zero events, about which the tail says nothing. The first draft
    // omitted the guard and two existing specs failed inside eight seconds, which
    // is the whole argument for stating a property where every test drives it
    // rather than in the one spec that walks to it deliberately.
    invariant(
      events.length === 0 || resolved >= startIndex + events.length,
      "session.page.tail",
      () => ({
        sessionId,
        startIndex,
        events: events.length,
        tail: resolved,
      }),
    );
    return { events, tail: resolved };
  }

  return {
    durable: backend.durable,
    append,
    tail,
    read,
    flush,
    async hydrate(sessionId) {
      // The COUNT rather than the events: a resuming session needs to know where
      // to continue writing, and nothing in the process needs the history —
      // whoever wants it reads the stream.
      const stored = await backend.countEvents(sessionId);
      const entry = entryFor(sessionId);
      // **Pending events are RE-BASED onto the stored tail**, and this is not an
      // edge case — it is the ordinary path. The handshake frame
      // (`session.configured`) is emitted at zero RTT, before `session.start()`
      // and therefore before this query can have answered, so on a resume the
      // first event of the connection is always recorded at an index that
      // belongs to the previous one. Left alone it would collide: the append is
      // idempotent by primary key, so the new event would be silently DROPPED in
      // favour of the stored one at that index.
      //
      // Re-basing is safe precisely because nothing has been told these indices
      // yet — an index is only published by a stream READ, and a read flushes
      // first, so it cannot observe a pending event mid-rebase.
      entry.pending = entry.pending.map((event, offset) => ({
        index: stored + offset,
        json: event.json,
      }));
      // `max`, because an event past the retention cap advances the position
      // without ever entering `pending` — so the sum can be BEHIND where this
      // session has already got to, and a position must never go backwards.
      entry.next = Math.max(entry.next, stored + entry.pending.length);
    },
    discard(sessionId) {
      // The in-process entry only. The stored rows go with the slot values, in
      // the one `backend.discard` the state store's own `discard` makes — two
      // callers deleting the same session would be a second round trip for
      // nothing, and this stream is never reclaimed without that one.
      sessions.delete(sessionId);
    },
    clear() {
      sessions.clear();
    },
  };
}
