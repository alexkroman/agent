// Copyright 2026 the AAI authors. MIT license.
/**
 * The runtime's event-stream wiring: where a session's log is picked up, put
 * down, and read back as a conversation.
 *
 * The sibling of `runtime-session-state.ts`, split on the same seam and for the
 * same reason — that file is about the lifetime of a session's SLOT VALUES, this
 * one about the lifetime of its EVENT LOG, and `runtime.ts` is about transports
 * and sinks. They share a backend on purpose (see `session-state-store.ts`), so
 * a session's durable footprint has one selection rule and one reclaim.
 *
 * ## The three orderings here are the whole content of the module
 *
 * - **Hydrate before the log is written to.** A session resuming onto a
 *   replacement process has to learn where its log ENDS before it appends, or it
 *   restarts at index 0 and overwrites its own history — with the client already
 *   told, by the `session.configured` frame, that it may read from a position.
 * - **Restore history before the session is ready**, inside the
 *   `session.start()` window, for exactly the reasons `attachSessionState`'s doc
 *   gives for hydration: the window is after the client's handshake guard and
 *   before any tool can observe the session, and a rejection takes the existing
 *   failure path.
 * - **Flush on the way out.** The batch that has not been written yet is the
 *   part a crash costs, and a clean stop is the one time it costs nothing.
 */

import { SESSION_EVENT_READ_LIMIT } from "@alexkroman1/aai/host-internal";
import type { SessionEvent } from "@alexkroman1/aai/protocol";
import type { SessionCore } from "./session-core.ts";
import { historyFromEvents } from "./session-event-history.ts";
import type { SessionEventStream } from "./session-event-stream.ts";
import type { ResumeFindings } from "./session-resume-found.ts";

/**
 * Read a session's whole log, one page at a time.
 *
 * Paged rather than one unbounded read because the page size is what bounds a
 * response's memory, and this is the one caller that legitimately wants all of
 * it — so it asks repeatedly instead of raising the limit for everybody.
 *
 * @internal
 */
export async function readAllEvents(
  stream: SessionEventStream,
  sessionId: string,
): Promise<SessionEvent[]> {
  const all: SessionEvent[] = [];
  let from = 0;
  // Bounded by the tail the first read reports: a session that is emitting while
  // this runs must not be able to keep the loop going. Anything appended after
  // is by definition not part of the conversation being restored.
  for (;;) {
    const page = await stream.read(sessionId, from, SESSION_EVENT_READ_LIMIT);
    all.push(...page.events);
    from += page.events.length;
    if (page.events.length < SESSION_EVENT_READ_LIMIT || from >= page.tail) break;
  }
  return all;
}

/**
 * Wrap one session's `start` and `stop` so its event log continues on the way in
 * and is written out on the way out.
 *
 * @internal
 */
export function attachSessionStream(
  core: SessionCore,
  opts: {
    stream: SessionEventStream;
    sessionId: string;
    resumed: boolean;
    /**
     * Where "this resume restored a conversation" is recorded, so the greeting
     * can tell a real resume from an id that named nothing — see
     * `session-resume-found.ts`.
     */
    findings?: ResumeFindings | undefined;
  },
): void {
  const { stream, sessionId, resumed, findings } = opts;
  const startCore = core.start.bind(core);
  core.start = async () => {
    await stream.hydrate(sessionId);
    // Only on a RESUME. A fresh session's log is empty, so the read would be a
    // round trip that can only answer nothing — and `resumed` is known from the
    // socket's own `?sessionId=`, which is cheaper and more honest than
    // inferring it from a count.
    if (resumed) {
      const events = await readAllEvents(stream, sessionId);
      // ONE walk for both, so a tool call's anchor and the message it points at
      // cannot disagree — see `historyFromEvents`.
      const { messages, toolCalls } = historyFromEvents(events);
      if (messages.length > 0 || toolCalls.length > 0) {
        core.restoreHistory(messages, toolCalls);
        // Recorded only when there was something to restore: an EMPTY log is
        // exactly the case that must fall through to a greeting.
        findings?.record();
      }
    }
    await startCore();
  };

  const stopCore = core.stop.bind(core);
  core.stop = async () => {
    try {
      await stopCore();
    } finally {
      // In a `finally`, so a session that stopped by failing still writes out
      // what it recorded — the events leading up to a failure are the ones most
      // worth having. `flush` never rejects.
      await stream.flush(sessionId);
    }
  };
}
