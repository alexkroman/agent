// Copyright 2026 the AAI authors. MIT license.

import { MAX_SESSION_EVENTS, SESSION_EVENT_FLUSH_THRESHOLD } from "@alexkroman1/aai/host-internal";
import { EVENT_ID_PREFIX, SessionEventSchema } from "@alexkroman1/aai/protocol";
import { describe, expect, test, vi } from "vitest";
import { makeLogger } from "./_test-utils.ts";
import { createSessionEventStream, stampSessionEvent } from "./session-event-stream.ts";
import {
  createMemoryStateBackend,
  type SessionStateBackend,
  type StoredSessionEvent,
} from "./session-state-store.ts";

const SID = "s-1";

function makeStream(overrides?: Partial<SessionStateBackend>) {
  const backend = { ...createMemoryStateBackend(), ...overrides };
  const logger = makeLogger();
  return { stream: createSessionEventStream({ backend, logger }), backend, logger };
}

describe("session event stream — recording", () => {
  test("append stamps an envelope and returns the event", () => {
    const { stream } = makeStream();

    const event = stream.append(SID, { type: "speech.started" });

    expect(event.type).toBe("speech.started");
    expect(event.meta.id.startsWith(EVENT_ID_PREFIX)).toBe(true);
    expect(event.meta.at).toBeGreaterThan(0);
    // The stamped event is what goes on the wire, so it must satisfy the wire
    // schema — which is what makes `SessionEventBody` safe for emitters to pass.
    expect(SessionEventSchema.safeParse(event).success).toBe(true);
  });

  test("ids are distinct within a millisecond", () => {
    const { stream } = makeStream();
    // A tool call and its completion on a cached result really do land in the
    // same millisecond, so a plain (non-monotonic) ULID would order them by
    // nothing at all.
    const ids = Array.from({ length: 50 }, () => stream.append(SID, { type: "speech.started" }))
      .map((e) => e.meta.id)
      .sort();
    expect(new Set(ids).size).toBe(50);
    // Strictly increasing within the process, which is what monotonic buys.
    expect([...ids]).toEqual(ids);
  });

  test("append is SYNCHRONOUS: the tail advances before anything awaits", () => {
    const { stream } = makeStream();

    expect(stream.tail(SID)).toBe(0);
    stream.append(SID, { type: "speech.started" });
    stream.append(SID, { type: "speech.stopped" });

    // The whole ordering guarantee: a hook can never observe an event the log
    // does not yet have, and a client can be told its position immediately.
    expect(stream.tail(SID)).toBe(2);
  });

  test("sessions are independent", () => {
    const { stream } = makeStream();
    stream.append(SID, { type: "speech.started" });
    stream.append("s-2", { type: "speech.started" });
    expect(stream.tail(SID)).toBe(1);
    expect(stream.tail("s-2")).toBe(1);
  });
});

describe("session event stream — reading", () => {
  test("a read replays from index 0 by default", async () => {
    const { stream } = makeStream();
    stream.append(SID, { type: "user-transcript.committed", text: "one" });
    stream.append(SID, { type: "user-transcript.committed", text: "two" });

    const page = await stream.read(SID, 0);

    expect(page.events.map((e) => e.type)).toEqual([
      "user-transcript.committed",
      "user-transcript.committed",
    ]);
    expect(page.tail).toBe(2);
  });

  test("startIndex selects a position", async () => {
    const { stream } = makeStream();
    for (const text of ["a", "b", "c"]) {
      stream.append(SID, { type: "user-transcript.committed", text });
    }

    const page = await stream.read(SID, 2);

    expect(page.events).toHaveLength(1);
    expect(page.tail).toBe(3);
  });

  test("a read FLUSHES first, so it never reports a tail it cannot serve", async () => {
    const { stream } = makeStream();
    // Below the flush threshold and not a boundary event, so nothing has been
    // written out yet — the read has to do it, or it would answer `tail: 1` with
    // an empty page.
    stream.append(SID, { type: "speech.started" });

    const page = await stream.read(SID, 0);

    expect(page.events).toHaveLength(1);
    expect(page.tail).toBe(1);
  });

  test("a limit bounds the page, and the tail says there is more", async () => {
    const { stream } = makeStream();
    for (const text of ["a", "b", "c"]) {
      stream.append(SID, { type: "user-transcript.committed", text });
    }

    const page = await stream.read(SID, 0, 2);

    expect(page.events).toHaveLength(2);
    // `tail` is the log's length, not the page's end — which is how a reader
    // knows to come straight back rather than waiting.
    expect(page.tail).toBe(3);
  });

  test("an unparsable stored row is dropped, not fatal to the read", async () => {
    const { stream, logger } = makeStream({
      readEvents: () => Promise.resolve([{ index: 0, json: "{not json" }]),
    });

    const page = await stream.read(SID, 0);

    expect(page.events).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      "Stored session event dropped",
      expect.objectContaining({ index: 0 }),
    );
  });

  test("a stored row that is not a session event is dropped too", async () => {
    // Parses, but is not a member of the union — the same fail-open rule the
    // slot store applies to shape drift after a redeploy.
    const { stream } = makeStream({
      readEvents: () => Promise.resolve([{ index: 0, json: '{"type":"retired.event"}' }]),
    });
    await expect(stream.read(SID, 0)).resolves.toEqual({ events: [], tail: 0 });
  });
});

describe("session event stream — persistence", () => {
  test("a turn boundary flushes the batch", async () => {
    const written: StoredSessionEvent[] = [];
    const { stream } = makeStream({
      appendEvents: (_sid, events) => {
        written.push(...events);
        return Promise.resolve();
      },
    });

    stream.append(SID, { type: "user-transcript.committed", text: "hi" });
    expect(written).toHaveLength(0);
    stream.append(SID, { type: "reply.completed" });
    // Fire-and-forget from `append`, so the write lands on a later microtask.
    await vi.waitFor(() => expect(written).toHaveLength(2));
  });

  test("the pending batch flushes at the threshold, before any boundary", async () => {
    const written: StoredSessionEvent[] = [];
    const { stream } = makeStream({
      appendEvents: (_sid, events) => {
        written.push(...events);
        return Promise.resolve();
      },
    });

    // A 10-step tool chain runs long past this without reaching a turn boundary,
    // which is what the threshold is for.
    for (let i = 0; i < SESSION_EVENT_FLUSH_THRESHOLD; i++) {
      stream.append(SID, { type: "speech.started" });
    }

    await vi.waitFor(() => expect(written).toHaveLength(SESSION_EVENT_FLUSH_THRESHOLD));
  });

  test("a failed write is retried on the next flush, in index order", async () => {
    let fail = true;
    const written: StoredSessionEvent[] = [];
    const { stream, logger } = makeStream({
      appendEvents: (_sid, events) => {
        if (fail) return Promise.reject(new Error("no database"));
        written.push(...events);
        return Promise.resolve();
      },
    });

    stream.append(SID, { type: "speech.started" });
    await stream.flush(SID);
    expect(logger.warn).toHaveBeenCalledWith(
      "Session events not stored",
      expect.objectContaining({ sessionId: SID }),
    );

    fail = false;
    stream.append(SID, { type: "speech.stopped" });
    await stream.flush(SID);

    // Nothing was lost, and the retry carries the ORIGINAL indices — the append
    // is idempotent by primary key, so overlapping a partial success is a no-op
    // rather than a duplicate.
    expect(written.map((e) => e.index)).toEqual([0, 1]);
  });

  test("flush never rejects", async () => {
    const { stream } = makeStream({
      appendEvents: () => Promise.reject(new Error("no database")),
    });
    stream.append(SID, { type: "speech.started" });
    // It runs in a session's teardown `finally` and from an emit on the audio
    // path; a rejection there is an unhandled rejection.
    await expect(stream.flush(SID)).resolves.toBeUndefined();
  });

  test("past the retention cap the index still advances and the log stops growing", async () => {
    const { stream, logger } = makeStream();
    const entry = { type: "speech.started" } as const;
    for (let i = 0; i < MAX_SESSION_EVENTS + 2; i++) stream.append(SID, entry);

    expect(stream.tail(SID)).toBe(MAX_SESSION_EVENTS + 2);
    const page = await stream.read(SID, MAX_SESSION_EVENTS - 1, 10);
    // The capped events are not stored, so a reader sees the log end there —
    // while every one of them still reached the client.
    expect(page.events).toHaveLength(1);
    // Reported ONCE, not per event.
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

describe("session event stream — hydration", () => {
  test("a resume continues the log rather than restarting at 0", async () => {
    const backend = createMemoryStateBackend();
    const first = createSessionEventStream({ backend });
    first.append(SID, { type: "user-transcript.committed", text: "before" });
    await first.flush(SID);

    // A replacement process: same backend, fresh in-process state.
    const second = createSessionEventStream({ backend });
    await second.hydrate(SID);
    second.append(SID, { type: "user-transcript.committed", text: "after" });
    await second.flush(SID);

    const page = await second.read(SID, 0);
    expect(page.events.map((e) => ("text" in e ? e.text : ""))).toEqual(["before", "after"]);
    expect(page.tail).toBe(2);
  });

  test("hydration RE-BASES an event recorded before the position was known", async () => {
    const backend = createMemoryStateBackend();
    const first = createSessionEventStream({ backend });
    first.append(SID, { type: "user-transcript.committed", text: "before" });
    await first.flush(SID);

    // The ordinary resume path: the handshake frame is emitted at zero RTT,
    // before `session.start()` and therefore before `hydrate` can have answered.
    const second = createSessionEventStream({ backend });
    second.append(SID, {
      type: "session.configured",
      audioFormat: "pcm16",
      sampleRate: 16_000,
      ttsSampleRate: 24_000,
    });
    await second.hydrate(SID);
    await second.flush(SID);

    const page = await second.read(SID, 0);
    // Without the re-base the handshake would have been written at index 0,
    // where `on conflict do nothing` silently drops it in favour of the stored
    // event — losing the frame AND leaving the reported tail wrong.
    expect(page.events.map((e) => e.type)).toEqual([
      "user-transcript.committed",
      "session.configured",
    ]);
    expect(page.tail).toBe(2);
  });

  test("a SPARSE log resumes past its highest index, not past its count", async () => {
    // `countEvents` answered `count(*)`, which equals the next free index only
    // for a log dense from zero. A hole — a partly-lost flush, or the retention
    // cap — made the count SMALLER than the highest index written, so a resumed
    // session continued at a position it had already used: its `tail` went
    // backwards and `on conflict do nothing` silently discarded the re-appends.
    const backend = createMemoryStateBackend();
    // Indices 0 and 5 stored, nothing between — five events' worth of hole.
    const stored = (index: number) => ({
      index,
      json: JSON.stringify(stampSessionEvent({ type: "speech.started" })),
    });
    await backend.appendEvents(SID, [stored(0), stored(5)]);
    await expect(backend.countEvents(SID)).resolves.toBe(6);

    const stream = createSessionEventStream({ backend });
    await stream.hydrate(SID);
    expect(stream.tail(SID)).toBe(6);
    stream.append(SID, { type: "user-transcript.committed", text: "after" });
    await stream.flush(SID);

    const page = await stream.read(SID, 0);
    // Three distinct events, not two — the new one did not land on index 2 and
    // get dropped, and the tail only ever moved forwards.
    expect(page.events).toHaveLength(3);
    expect(page.tail).toBe(7);
  });

  test("a fresh session hydrates to nothing", async () => {
    const { stream } = makeStream();
    await stream.hydrate("never-seen");
    expect(stream.tail("never-seen")).toBe(0);
  });
});

describe("session event stream — reclamation", () => {
  test("discard drops the in-process entry and leaves the rows to the state store", async () => {
    const { stream, backend } = makeStream();
    const discard = vi.spyOn(backend, "discard");
    stream.append(SID, { type: "speech.started" });
    await stream.flush(SID);

    stream.discard(SID);

    expect(stream.tail(SID)).toBe(0);
    // One `backend.discard` reclaims both a session's slot values and its
    // events, and the state store's own `discard` is the caller — two callers
    // would be a second round trip for nothing.
    expect(discard).not.toHaveBeenCalled();
  });

  test("clear drops every entry without touching stored rows", async () => {
    const backend = createMemoryStateBackend();
    const stream = createSessionEventStream({ backend });
    stream.append(SID, { type: "speech.started" });
    await stream.flush(SID);

    stream.clear();

    expect(stream.tail(SID)).toBe(0);
    // The rows belong to a session that may yet resume onto a replacement
    // process — which is the whole point of storing them.
    await expect(backend.countEvents(SID)).resolves.toBe(1);
  });
});

describe("stampSessionEvent", () => {
  test("stamps a body that has no session to be recorded in", () => {
    const event = stampSessionEvent({
      type: "error.reported",
      code: "protocol",
      message: "no",
      fatal: true,
    });
    expect(SessionEventSchema.safeParse(event).success).toBe(true);
  });
});

describe("reading a session this process never handled", () => {
  /**
   * A DURABLE backend outlives the process that wrote to it, so a read can
   * legitimately be the first this process has heard of the session. `events`
   * comes from the backend and was always right; `tail` came from the
   * in-process map — `sessions.get(id)?.next ?? 0` — so the two disagreed
   * exactly in the case a durable store exists for.
   *
   * Measured against a real Postgres under `aai dev`: a session written by one
   * process, read after a restart, answered `tail: 0` beside four events, while
   * a session created on the reading process answered `tail: 4`.
   *
   * It matters because `tail` is a CURSOR. A client resuming from it re-reads
   * the stream from zero, and a reader treating it as "how much exists"
   * concludes the session is empty while holding four of its events.
   */
  test("reports the STORED tail, not zero", async () => {
    // Write through one stream, then read through a second over the same
    // backend — the process boundary, with nothing else changed.
    const backend = createMemoryStateBackend();
    const writer = createSessionEventStream({ backend, logger: makeLogger() });
    for (let i = 0; i < 4; i++) {
      writer.append(SID, stampSessionEvent({ type: "reply.cancelled" }));
    }
    await writer.flush(SID);
    await expect(backend.countEvents(SID)).resolves.toBe(4);

    const reader = createSessionEventStream({ backend, logger: makeLogger() });
    const page = await reader.read(SID, 0);
    expect(page.events).toHaveLength(4);
    expect(page.tail).toBe(4);
  });

  test("a session the backend has never heard of still reports zero", async () => {
    const { stream } = makeStream();
    const page = await stream.read("never-existed", 0);
    expect(page.events).toEqual([]);
    expect(page.tail).toBe(0);
  });
});
