// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the two read-until-it-ends iterators, and for the SSE parser under
 * them.
 *
 * What they pin is the half a caller cannot check by eye: the two CONTINUATION
 * rules (an `idle` frame is the state stream handing the client back, and one
 * output read is bounded by the tail so the next must resume from an absolute
 * index) and the difference between a run that finished and a connection that
 * dropped — the one failure a caller would act on wrongly if it were reported
 * as an ending.
 *
 * The parser's three edges are asserted here rather than left to the browser
 * client that used to own it: a CRLF stream, an `event:` with no space, and a
 * multi-line `data:`. Each is a shape our own server does not emit and an
 * intermediary may.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { readEventStream } from "./event-stream.ts";
import { followRun, followRunOutput, type RunStreamOpener } from "./workflow-api-follow.ts";
import type { WorkflowRunSnapshot } from "./workflow-run.ts";

/** An SSE response carrying exactly `text`. */
function sse(text: string): Response {
  return new Response(text, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/** One frame, in the shape both routes write. */
function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function run(status: WorkflowRunSnapshot["status"] = "running"): WorkflowRunSnapshot {
  return { runId: "wrun_1", workflow: "digest", createdAt: 0, status } as WorkflowRunSnapshot;
}

/** An opener whose `watch` answers the given responses in order. */
function opener(over: Partial<RunStreamOpener>): RunStreamOpener {
  return {
    watch: vi.fn(async () => sse("")),
    streamOutput: vi.fn(async () => sse("")),
    ...over,
  } as RunStreamOpener;
}

/** Everything an iterable yields. */
async function drain<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of source) out.push(value);
  return out;
}

describe("followRun", () => {
  test("yields every snapshot and ends on the terminal one", async () => {
    const api = opener({
      watch: vi.fn(async () =>
        sse(frame("run", run("running")) + frame("run", run("completed")) + frame("done", {})),
      ),
    });
    const seen = await drain(followRun(api, "wrun_1"));
    expect(seen.map((r) => r.status)).toEqual(["running", "completed"]);
    // The terminal SNAPSHOT ends it, so the trailing `done` costs no second read.
    expect(api.watch).toHaveBeenCalledTimes(1);
  });

  test("an `idle` frame RE-OPENS, because the route capped its own duration", async () => {
    // The whole reason this is not a hand-written loop: a run may sleep for
    // hours, and the stream hands the client back rather than pretending the
    // link is alive.
    const responses = [
      sse(frame("run", run("running")) + frame("idle", { runId: "wrun_1" })),
      sse(frame("run", run("completed"))),
    ];
    const api = opener({ watch: vi.fn(async () => responses.shift() ?? sse("")) });
    const seen = await drain(followRun(api, "wrun_1"));
    expect(seen.map((r) => r.status)).toEqual(["running", "completed"]);
    expect(api.watch).toHaveBeenCalledTimes(2);
  });

  test("ends quietly on `missing` — an id that does not exist never will", async () => {
    const api = opener({ watch: vi.fn(async () => sse(frame("missing", { runId: "nope" }))) });
    await expect(drain(followRun(api, "nope"))).resolves.toEqual([]);
  });

  test("a stream that ends with the run unsettled THROWS, rather than looking finished", async () => {
    const api = opener({ watch: vi.fn(async () => sse(frame("run", run("running")))) });
    await expect(drain(followRun(api, "wrun_1"))).rejects.toThrow(/ended before the run settled/);
  });

  test("a refused stream carries the AGENT's own sentence", async () => {
    const api = opener({
      watch: vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "This agent serves no workflow API" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    });
    await expect(drain(followRun(api, "wrun_1"))).rejects.toThrow(/serves no workflow API/);
  });

  test("an aborted signal ends the iteration without opening a stream", async () => {
    const api = opener({});
    await expect(drain(followRun(api, "wrun_1", AbortSignal.abort()))).resolves.toEqual([]);
    expect(api.watch).not.toHaveBeenCalled();
  });
});

describe("followRunOutput", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    return () => void vi.useRealTimers();
  });

  test("yields chunks and ends when the RUN is complete", async () => {
    const api = opener({
      streamOutput: vi.fn(async () =>
        sse(frame("chunk", "one") + frame("chunk", "two") + frame("done", { complete: true })),
      ),
    });
    await expect(drain(followRunOutput(api, "wrun_1"))).resolves.toEqual(["one", "two"]);
  });

  test("re-opens from the ABSOLUTE next index while the run is still going", async () => {
    // A read is bounded by the tail it saw, so `complete: false` means "ask
    // again" — and asking from the wrong index is how a reader silently loses or
    // repeats chunks.
    //
    // Served by an opener that HONOURS the cursor. A fixed two-response script
    // hands back "a","b","c" whatever index is asked for, so the two
    // `startIndex` assertions below were the whole of the test — and they pinned
    // an INCLUSIVE reading against a store that had gone exclusive, where this
    // same loop loses the chunk at every cursor. The list is the assertion now;
    // the indices are the evidence.
    const log = ["a", "b", "c", "d", "e", "f", "g", "h"];
    // The run's tail at each poll: `f` lands between the two reads, so the first
    // is bounded short of the log and the second has to resume exactly where it
    // stopped.
    const tails = [6, log.length];
    let poll = 0;
    const api = opener({
      streamOutput: vi.fn(async (_runId: string, options?: { startIndex?: number }) => {
        const visible = log.slice(0, tails[poll] ?? log.length);
        const complete = poll >= tails.length - 1;
        poll += 1;
        // A non-negative `startIndex` is an INCLUSIVE floor — see
        // `StreamOptions.startIndex`. Nothing drops from the front of a fresh
        // channel, so the floor is the slice offset.
        const from = options?.startIndex ?? 0;
        return sse(
          visible
            .slice(from)
            .map((value) => frame("chunk", value))
            .join("") + frame("done", { complete }),
        );
      }),
    });
    const collected: unknown[] = [];
    const finished = (async () => {
      for await (const chunk of followRunOutput(api, "wrun_1", { fromIndex: 5 })) {
        collected.push(chunk);
      }
    })();
    await vi.advanceTimersByTimeAsync(2000);
    await finished;
    // From index 5 INCLUSIVE, so `f` is the first chunk and nothing repeats.
    expect(collected).toEqual(["f", "g", "h"]);
    const calls = (api.streamOutput as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]?.[1]).toMatchObject({ startIndex: 5 });
    expect(calls[1]?.[1]).toMatchObject({ startIndex: 6 });
  });

  test("a DEFAULT follow yields the run's first chunk", async () => {
    // The user-facing half of the off-by-one this file could not see: with no
    // `fromIndex`, `followRunOutput` sends `startIndex: 0`, and a store that read
    // that as an exclusive floor answered with everything except chunk 0 — a
    // run's first progress line, lost permanently, on the default call.
    const log = ["first", "second"];
    const api = opener({
      streamOutput: vi.fn(async (_runId: string, options?: { startIndex?: number }) =>
        sse(
          log
            .slice(options?.startIndex ?? 0)
            .map((value) => frame("chunk", value))
            .join("") + frame("done", { complete: true }),
        ),
      ),
    });
    await expect(drain(followRunOutput(api, "wrun_1"))).resolves.toEqual(log);
    const calls = (api.streamOutput as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]?.[1]).toMatchObject({ startIndex: 0 });
  });

  test("a namespace is forwarded, and an absent one is not sent at all", async () => {
    const api = opener({
      streamOutput: vi.fn(async () => sse(frame("done", { complete: true }))),
    });
    await drain(followRunOutput(api, "wrun_1", { namespace: "segments" }));
    await drain(followRunOutput(api, "wrun_1"));
    const calls = (api.streamOutput as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]?.[1]).toMatchObject({ namespace: "segments" });
    expect(calls[1]?.[1]).not.toHaveProperty("namespace");
  });
});

describe("readEventStream", () => {
  test("parses a CRLF stream — no two adjacent \\n, which a splitter cannot see", async () => {
    const body = sse('event: run\r\ndata: {"status":"running"}\r\n\r\n').body;
    if (!body) throw new Error("a Response built from text has a body");
    await expect(drain(readEventStream(body))).resolves.toEqual([
      { event: "run", data: { status: "running" } },
    ]);
  });

  test("the space after `event:` is optional, and a `data:` may span lines", async () => {
    const body = sse('event:chunk\ndata: {"a":\ndata: 1}\n\n').body;
    if (!body) throw new Error("a Response built from text has a body");
    await expect(drain(readEventStream(body))).resolves.toEqual([
      { event: "chunk", data: { a: 1 } },
    ]);
  });

  test("a heartbeat comment yields nothing, and unparseable data is not fatal", async () => {
    const body = sse(": ping\n\nevent: run\ndata: not json\n\n").body;
    if (!body) throw new Error("a Response built from text has a body");
    await expect(drain(readEventStream(body))).resolves.toEqual([
      { event: "run", data: undefined },
    ]);
  });
});
