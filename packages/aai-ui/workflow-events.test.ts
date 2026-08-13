// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/**
 * Specs for `watchRunEvents` — the push half of `useWorkflowRun`.
 *
 * The stream is fed a real `ReadableStream` of bytes rather than parsed frames,
 * because the parser is half of what this module is: a frame is not guaranteed
 * to arrive whole, and a naive split on the delimiter is the failure that makes
 * a page silently stop updating.
 *
 * Every ending has to be classified correctly — a `settled` ending means the
 * caller stops, a `fallback` ending means it starts polling — and getting one
 * backwards is either a run watched forever or a run that stops updating.
 */

import { describe, expect, test, vi } from "vitest";
import { type RunWatcher, watchRunEvents } from "./workflow-events.ts";

/** A response whose body yields `chunks` in order and then ends. */
function streamOf(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "Content-Type": "text/event-stream" } });
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A watcher whose `watch` answers with `response`. */
function apiWith(response: Response | (() => Promise<Response>)): () => RunWatcher {
  const watch = typeof response === "function" ? response : async () => response;
  return () => ({ watch });
}

/** Run one watch to completion, reporting what it did. */
async function collect(
  response: Response | (() => Promise<Response>),
): Promise<{ runs: unknown[]; settled: number; fallback: number; stop: () => void }> {
  const runs: unknown[] = [];
  let settled = 0;
  let fallback = 0;
  const stop = watchRunEvents(
    apiWith(response),
    "wrun_1",
    (run) => runs.push(run),
    () => {
      settled += 1;
    },
    () => {
      fallback += 1;
    },
  );
  // The pump is promise-driven, so draining the microtask queue is enough.
  for (let i = 0; i < 20; i++) await Promise.resolve();
  return { runs, settled, fallback, stop };
}

describe("watchRunEvents", () => {
  test("reports each `run` frame and SETTLES on `done`", async () => {
    const running = { runId: "wrun_1", status: "running" };
    const completed = { runId: "wrun_1", status: "completed", output: 1 };
    const result = await collect(
      streamOf([
        frame("run", running),
        frame("run", completed),
        frame("done", { runId: "wrun_1" }),
      ]),
    );
    expect(result.runs).toEqual([running, completed]);
    expect(result.settled).toBe(1);
    expect(result.fallback).toBe(0);
  });

  test("`missing` settles too — the id will never exist", async () => {
    const result = await collect(streamOf([frame("missing", { runId: "gone" })]));
    expect(result.settled).toBe(1);
    expect(result.fallback).toBe(0);
  });

  test("`idle` hands back to the POLL — the stream capped itself, the run is live", async () => {
    const result = await collect(streamOf([frame("idle", { runId: "wrun_1" })]));
    expect(result.settled).toBe(0);
    expect(result.fallback).toBe(1);
  });

  test("an agent that does not serve the route falls back", async () => {
    // The ordinary case for one deployed before `/events` existed.
    const result = await collect(new Response(null, { status: 404 }));
    expect(result.fallback).toBe(1);
  });

  test("a stream that ends with no final frame is a DROPPED connection", async () => {
    const result = await collect(streamOf([frame("run", { runId: "wrun_1", status: "running" })]));
    expect(result.runs).toHaveLength(1);
    expect(result.fallback).toBe(1);
  });

  test("a rejected watch falls back rather than throwing", async () => {
    const result = await collect(() => Promise.reject(new Error("Failed to fetch")));
    expect(result.fallback).toBe(1);
  });

  test("buffers across chunk boundaries — a frame need not arrive whole", async () => {
    const whole = frame("run", { runId: "wrun_1", status: "running" });
    const result = await collect(
      streamOf([whole.slice(0, 7), whole.slice(7, 20), whole.slice(20), frame("done", {})]),
    );
    expect(result.runs).toEqual([{ runId: "wrun_1", status: "running" }]);
    expect(result.settled).toBe(1);
  });

  test("skips heartbeat comment frames", async () => {
    const result = await collect(
      streamOf([": ping\n\n", frame("run", { runId: "wrun_1" }), ": ping\n\n", frame("done", {})]),
    );
    expect(result.runs).toHaveLength(1);
    expect(result.settled).toBe(1);
  });

  test("an unparseable frame does not tear the stream down", async () => {
    // Every frame carries a WHOLE snapshot, so the next one restates the state.
    const result = await collect(
      streamOf([
        "event: run\ndata: {not json\n\n",
        frame("run", { runId: "wrun_1", status: "running" }),
        frame("done", {}),
      ]),
    );
    expect(result.runs).toEqual([{ runId: "wrun_1", status: "running" }]);
    expect(result.settled).toBe(1);
  });

  test("stopping aborts and reports NEITHER outcome", async () => {
    // A teardown is not a fallback: the caller is gone, so starting a poll for
    // it would be a request nobody reads.
    const watch = vi.fn(
      (_id: string, signal?: AbortSignal) =>
        new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    let settled = 0;
    let fallback = 0;
    const stop = watchRunEvents(
      () => ({ watch }),
      "wrun_1",
      () => undefined,
      () => {
        settled += 1;
      },
      () => {
        fallback += 1;
      },
    );
    stop();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(settled).toBe(0);
    expect(fallback).toBe(0);
  });
});
