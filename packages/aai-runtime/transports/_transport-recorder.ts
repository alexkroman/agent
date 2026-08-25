// Copyright 2026 the AAI authors. MIT license.
/**
 * The test double for {@link TransportCallbacks}: a recorder that fans `report`
 * out into one spy per event type.
 *
 * Its own module because it is not pipeline-specific and three files had written
 * it out by hand — `_pipeline-transport-harness.ts`, `s2s-transport.test.ts` and
 * `pipeline-open-latency.test.ts` each carried a fourteen-entry `vi.fn()` literal,
 * which is the multiplier a per-name callback surface has: every harness standing
 * in for the thing that fires a callback has to satisfy its whole shape. There is
 * one shape left to satisfy and one place that satisfies it.
 *
 * Deliberately does NOT import `../_test-utils.ts`: that module's exports are
 * vitest-spy-typed and excluded from the declaration build, while this file is
 * compiled by it.
 *
 * @internal Test infrastructure, not part of any public API.
 */

import { vi } from "vitest";
import type { TransportCallbacks, TransportEventBody, TransportEventType } from "./types.ts";

/**
 * One reported event type's spy.
 *
 * Typed by the whole union rather than narrowed to the requested `type`, and that
 * is a deliberate trade: narrowing would make the spy store a heterogeneous map,
 * which a double cast is the only way to read back out of. The looseness costs
 * nothing an assertion wants — `toHaveBeenCalledWith` still rejects a field the
 * named event does not have — and the escape-hatch budget is worth more.
 */
export type EventSpy = ReturnType<typeof vi.fn<(event: TransportEventBody) => void>>;

/**
 * A {@link TransportCallbacks} whose reports are recorded per event type.
 *
 * A better double than the fourteen named `vi.fn()`s it replaces, not merely a
 * smaller one: the spies are minted on demand from the wire vocabulary, so a new
 * event needs no entry here, and an assertion reads the whole event —
 * `toHaveBeenCalledWith({ type: "user-transcript.updated", text: "hi" })` — where
 * `onUserTranscriptPartial` could only ever show its positional arguments.
 */
export type RecordingCallbacks = TransportCallbacks & {
  /**
   * The spy for one event type. Stable across calls, so `mockClear()` and
   * `toHaveBeenCalledTimes` behave exactly as they did on a named callback.
   */
  reported(type: TransportEventType): EventSpy;
  /** Every event reported, in order — for an assertion about ORDERING. */
  events: TransportEventBody[];
};

export function makeCallbacks(): RecordingCallbacks {
  const events: TransportEventBody[] = [];
  const spies = new Map<TransportEventType, EventSpy>();
  const spyFor = (type: TransportEventType): EventSpy => {
    const existing = spies.get(type);
    if (existing) return existing;
    const created = vi.fn<(event: TransportEventBody) => void>();
    spies.set(type, created);
    return created;
  };
  return {
    report: vi.fn((event: TransportEventBody) => {
      events.push(event);
      spyFor(event.type)(event);
    }),
    onReplyStarted: vi.fn(),
    onAudioChunk: vi.fn(),
    events,
    reported: spyFor,
  };
}

/**
 * The `text` of every interim agent transcript reported so far, in order.
 *
 * Replaces `partialTranscriptSpy`, which existed only to narrow away
 * `onAgentTranscriptPartial`'s optionality — an optionality that no longer
 * exists, because an interim snapshot is `agent-transcript.updated` and every
 * transport reports the same event. What is left is the projection its four
 * callers actually wanted: each reached through `.mock.calls` for the string.
 */
export function partialTranscripts(callbacks: RecordingCallbacks): string[] {
  return callbacks.events.filter((e) => e.type === "agent-transcript.updated").map((e) => e.text);
}
