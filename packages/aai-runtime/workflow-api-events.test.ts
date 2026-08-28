// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for `GET /workflows/runs/:id/events`.
 *
 * On VIRTUAL TIME, because everything this module decides is a timer: when it
 * re-reads, when it heartbeats, and when it gives the client back. Waiting those
 * out on the wall clock would make the file a multi-second race whose flake
 * names a timing spec rather than a bug — and it would cap what a spec can
 * describe, since the stream's own five-minute cap could never be reached.
 *
 * The response is a fake sink rather than a real `ServerResponse`: what these
 * assert is the FRAME SEQUENCE, and reading it back off a socket adds a parser
 * with no invariant of its own.
 */

import type { WorkflowRunSnapshot } from "@alexkroman1/aai/workflow-api";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type EventSink,
  RUN_EVENT_HEARTBEAT_MS,
  RUN_EVENT_MAX_READ_FAILURES,
  RUN_EVENT_POLL_MS,
  RUN_EVENT_STREAM_MAX_MS,
  type RunReader,
  streamRunEvents,
} from "./workflow-api-events.ts";

/**
 * A response that records what was written, plus the `close` listener.
 *
 * A plain object rather than a cast `ServerResponse`, which is what
 * {@link EventSink} exists for: the module names the four members it touches,
 * so the double can satisfy them honestly.
 */
function fakeRes(): { res: EventSink; chunks: string[]; head: () => unknown } {
  const chunks: string[] = [];
  let head: unknown;
  const res: EventSink = {
    writeHead: (status, headers) => {
      head = { status, headers };
      return res;
    },
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
    end: () => {
      chunks.push("<end>");
    },
    on: () => res,
  };
  return { res, chunks, head: () => head };
}

function run(over: Partial<WorkflowRunSnapshot> = {}): WorkflowRunSnapshot {
  return {
    runId: "wrun_1",
    workflow: "digest",
    createdAt: 0,
    status: "running",
    ...over,
  } as WorkflowRunSnapshot;
}

/** The events, in order, ignoring heartbeats. */
function events(chunks: string[]): string[] {
  return chunks
    .filter((c) => c.startsWith("event: "))
    .map((c) => c.slice("event: ".length).split("\n")[0] as string);
}

/** A reader answering a scripted sequence, holding the last value afterwards. */
function reader(script: (WorkflowRunSnapshot | undefined)[]): RunReader {
  let i = 0;
  return {
    get: vi.fn(async () => script[Math.min(i++, script.length - 1)]),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("streamRunEvents", () => {
  test("opens as an unbuffered event stream", async () => {
    const { res, head } = fakeRes();
    streamRunEvents(res, reader([run({ status: "completed", output: 1 })]), "wrun_1");
    await vi.advanceTimersByTimeAsync(0);
    expect(head()).toEqual({
      status: 200,
      headers: expect.objectContaining({
        "Content-Type": "text/event-stream",
        // The conventional opt-out for proxies that would otherwise buffer the
        // whole stream and defeat the point of it.
        "X-Accel-Buffering": "no",
      }),
    });
  });

  test("sends the run, then `done`, and ends once it is terminal", async () => {
    const { res, chunks } = fakeRes();
    streamRunEvents(res, reader([run({ status: "completed", output: { ok: true } })]), "wrun_1");
    await vi.advanceTimersByTimeAsync(0);
    expect(events(chunks)).toEqual(["run", "done"]);
    expect(chunks.at(-1)).toBe("<end>");
    expect(chunks[0]).toContain('"status":"completed"');
  });

  test("an unknown run is `missing` — a stable answer, not something to wait for", async () => {
    const { res, chunks } = fakeRes();
    streamRunEvents(res, reader([undefined]), "gone");
    await vi.advanceTimersByTimeAsync(0);
    expect(events(chunks)).toEqual(["missing"]);
  });

  test("re-reads a live run and only sends a frame when the state CHANGED", async () => {
    const { res, chunks } = fakeRes();
    streamRunEvents(res, reader([run(), run(), run({ status: "completed", output: 1 })]), "wrun_1");
    await vi.advanceTimersByTimeAsync(0);
    expect(events(chunks)).toEqual(["run"]);
    // A second identical read: the bytes are the same, so there is nothing to
    // tell the client.
    await vi.advanceTimersByTimeAsync(RUN_EVENT_POLL_MS);
    expect(events(chunks)).toEqual(["run"]);
    await vi.advanceTimersByTimeAsync(RUN_EVENT_POLL_MS);
    expect(events(chunks)).toEqual(["run", "run", "done"]);
  });

  test("a failed read HOLDS the stream and tries again", async () => {
    // Ending here would send a page back to polling over a blip.
    let calls = 0;
    const failing: RunReader = {
      get: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error("transient");
        return run({ status: "completed", output: 1 });
      }),
    };
    const { res, chunks } = fakeRes();
    streamRunEvents(res, failing, "wrun_1");
    await vi.advanceTimersByTimeAsync(0);
    expect(events(chunks)).toEqual([]);
    await vi.advanceTimersByTimeAsync(RUN_EVENT_POLL_MS);
    expect(events(chunks)).toEqual(["run", "done"]);
  });

  test("heartbeats while the run is live, so a departed client is noticed", async () => {
    const { res, chunks } = fakeRes();
    streamRunEvents(res, reader([run()]), "wrun_1");
    await vi.advanceTimersByTimeAsync(RUN_EVENT_HEARTBEAT_MS);
    expect(chunks).toContain(": ping\n\n");
  });

  test("hands the client back with `idle` at the duration cap", async () => {
    // A run can sleep for hours, and a connection held that long is one nothing
    // is maintaining — ending it cleanly puts the client on a path it has.
    const { res, chunks } = fakeRes();
    streamRunEvents(res, reader([run()]), "wrun_1");
    await vi.advanceTimersByTimeAsync(RUN_EVENT_STREAM_MAX_MS + RUN_EVENT_POLL_MS);
    expect(events(chunks).at(-1)).toBe("idle");
    expect(chunks.at(-1)).toBe("<end>");
  });

  test("close() ends the response cleanly rather than destroying it", async () => {
    // A chunked body cut mid-frame is a protocol error to whatever is reading;
    // on the platform that reader is a proxy, which reports it as a transfer
    // failure with nothing tying it back to the shutdown that caused it.
    const { res, chunks } = fakeRes();
    const stream = streamRunEvents(res, reader([run()]), "wrun_1");
    await vi.advanceTimersByTimeAsync(0);
    stream.close();
    expect(chunks.at(-1)).toBe("<end>");
  });

  test("close() is idempotent and stops every later frame", async () => {
    const { res, chunks } = fakeRes();
    const stream = streamRunEvents(res, reader([run()]), "wrun_1");
    await vi.advanceTimersByTimeAsync(0);
    stream.close();
    stream.close();
    const after = chunks.length;
    await vi.advanceTimersByTimeAsync(RUN_EVENT_STREAM_MAX_MS);
    expect(chunks).toHaveLength(after);
  });

  test("an empty run id is `missing`, without asking the world about it", async () => {
    // The route's `/events` suffix is stripped off whatever precedes it, so
    // `GET /workflows/runs//events` — and its reachable spelling
    // `/workflows/runs/events` — arrive here with the empty string. Every other
    // run-id route refuses it before the read (`readRun` and `streamRunOutput`
    // both spell `runId ? … : undefined`; `cancelRun` and `wakeRun` both open
    // with `if (!runId)`), because the world rejects an id it cannot parse
    // rather than answering "no such run" for it. Reaching the read was
    // observed under `aai dev` as a stream that sent nothing but heartbeats for
    // its full five-minute cap.
    const empty = reader([run()]);
    const { res, chunks } = fakeRes();
    streamRunEvents(res, empty, "");
    await vi.advanceTimersByTimeAsync(0);
    expect(events(chunks)).toEqual(["missing"]);
    expect(chunks.at(-1)).toBe("<end>");
    expect(empty.get).not.toHaveBeenCalled();
  });

  test("a read that keeps failing hands the client back rather than holding in silence", async () => {
    // Holding through a BLIP is the point of the retry above; holding through a
    // permanent failure is not. Nothing downstream can tell the two apart —
    // the frames are identical (none) — so an unbounded retry presents a dead
    // stream as a healthy idle one until the duration cap, and the client's own
    // poll, which would have surfaced the error, never takes over.
    const failing: RunReader = { get: vi.fn(async () => Promise.reject(new Error("world gone"))) };
    const logger = { warn: vi.fn() };
    const { res, chunks } = fakeRes();
    streamRunEvents(res, failing, "wrun_1", { logger });
    await vi.advanceTimersByTimeAsync(RUN_EVENT_POLL_MS * (RUN_EVENT_MAX_READ_FAILURES + 2));
    expect(events(chunks)).toEqual(["idle"]);
    expect(chunks.at(-1)).toBe("<end>");
    expect(failing.get).toHaveBeenCalledTimes(RUN_EVENT_MAX_READ_FAILURES);
    // And the error is REPORTED. Swallowed, a lost database looked exactly like
    // a quiet run.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("read failed"),
      expect.objectContaining({ runId: "wrun_1", error: "world gone" }),
    );
  });

  test("an intermittent read does not accumulate toward the failure cap", async () => {
    // The cap counts CONSECUTIVE failures: a stream watching a run for minutes
    // over a flaky link would otherwise reach any fixed total eventually.
    let calls = 0;
    const flaky: RunReader = {
      get: vi.fn(async () => {
        calls += 1;
        if (calls % 2 === 1) throw new Error("blip");
        return run();
      }),
    };
    const { res, chunks } = fakeRes();
    streamRunEvents(res, flaky, "wrun_1");
    await vi.advanceTimersByTimeAsync(RUN_EVENT_POLL_MS * (RUN_EVENT_MAX_READ_FAILURES * 4));
    expect(events(chunks)).toEqual(["run"]);
    expect(chunks.at(-1)).not.toBe("<end>");
  });
});
