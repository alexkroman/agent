// Copyright 2026 the AAI authors. MIT license.
/**
 * The run-events SSE stream.
 *
 * Asserted on the BYTES written to the response, not on a handler return value:
 * every property that matters here is about the wire — the frame names a client
 * dispatches on, that a terminal run ends the stream rather than idling on it, and
 * that ending is a terminating chunk rather than a destroyed socket.
 */

import { describe, expect, test, vi } from "vitest";
import type { WorkflowRunSnapshot } from "../sdk/workflow.ts";
import { streamRunEvents } from "./workflow-api-events.ts";
import { RUN_EVENT_POLL_MS } from "./workflow-engine-limits.ts";

/** A `ServerResponse` reduced to what SSE uses, recording everything written. */
function fakeRes() {
  const chunks: string[] = [];
  const listeners: Record<string, () => void> = {};
  return {
    head: undefined as undefined | Record<string, string>,
    chunks,
    ended: false,
    writeHead(_status: number, headers: Record<string, string>) {
      this.head = headers;
    },
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    end() {
      this.ended = true;
    },
    on(event: string, cb: () => void) {
      listeners[event] = cb;
    },
    /** What a client would dispatch on, in order. */
    events(): string[] {
      return chunks.flatMap((c) => [...c.matchAll(/^event: (\w+)$/gm)].map((m) => m[1] as string));
    },
    payloads(): unknown[] {
      return chunks.flatMap((c) =>
        [...c.matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1] as string) as unknown),
      );
    },
  };
}

const run = (over: Partial<WorkflowRunSnapshot> = {}): WorkflowRunSnapshot =>
  ({
    runId: "r1",
    workflow: "w",
    status: "running",
    stepsCompleted: 0,
    ...over,
  }) as WorkflowRunSnapshot;

describe("streamRunEvents", () => {
  test("declares an event stream and sends the first snapshot immediately", async () => {
    const res = fakeRes();
    const reader = { get: vi.fn(() => Promise.resolve(run())) };
    streamRunEvents(res as never, reader, "r1");
    await vi.waitFor(() => expect(res.events()).toContain("run"));

    expect(res.head?.["Content-Type"]).toBe("text/event-stream");
    // Buffering anywhere in the chain defeats the point of a stream.
    expect(res.head?.["Cache-Control"]).toContain("no-transform");
    expect(res.head?.["X-Accel-Buffering"]).toBe("no");
  });

  test("sends nothing for an unchanged run, and a frame for each change", async () => {
    vi.useFakeTimers();
    try {
      const res = fakeRes();
      const snapshots = [run(), run(), run({ stepsCompleted: 1 })];
      let i = 0;
      const reader = { get: () => Promise.resolve(snapshots[Math.min(i++, 2)]) };
      streamRunEvents(res as never, reader, "r1");
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(RUN_EVENT_POLL_MS * 2 + 10);

      // Two reads were identical, so the client heard about the run twice, not
      // three times — a stream that re-sent an unchanged snapshot would just be a
      // poll with extra steps.
      expect(res.events().filter((e) => e === "run")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a terminal run ends the stream, cleanly, rather than idling on it", async () => {
    const res = fakeRes();
    const reader = { get: () => Promise.resolve(run({ status: "completed", output: 7 })) };
    streamRunEvents(res as never, reader, "r1");
    await vi.waitFor(() => expect(res.ended).toBe(true));

    expect(res.events()).toEqual(["run", "done"]);
    // `done` is distinct from a dropped connection, so a client can tell "finished"
    // from "reconnect" — without it every completed run would be redialled.
    expect(res.payloads().at(-1)).toEqual({ runId: "r1" });
  });

  test("an unknown id is a STABLE answer, so it says so and stops", async () => {
    // The journal is durable: a run the agent does not know about now will not
    // appear later, so holding the stream open would be waiting for nothing.
    const res = fakeRes();
    streamRunEvents(res as never, { get: () => Promise.resolve(undefined) }, "gone");
    await vi.waitFor(() => expect(res.ended).toBe(true));
    expect(res.events()).toEqual(["missing"]);
  });

  test("a failed read holds the stream instead of ending it", async () => {
    vi.useFakeTimers();
    try {
      const res = fakeRes();
      let calls = 0;
      const reader = {
        get: () => {
          calls += 1;
          return calls === 1 ? Promise.reject(new Error("blip")) : Promise.resolve(run());
        },
      };
      streamRunEvents(res as never, reader, "r1");
      await vi.advanceTimersByTimeAsync(0);
      // The failure said nothing about the run, so the stream must not send the
      // page back to polling over one dropped query.
      expect(res.ended).toBe(false);
      await vi.advanceTimersByTimeAsync(RUN_EVENT_POLL_MS + 10);
      expect(res.events()).toContain("run");
    } finally {
      vi.useRealTimers();
    }
  });

  test("close() ends the response rather than destroying it", async () => {
    // The distinction the platform's `live-streams.ts` exists for: a chunked body
    // cut mid-frame is a protocol error to whatever is reading.
    const res = fakeRes();
    const stream = streamRunEvents(res as never, { get: () => Promise.resolve(run()) }, "r1");
    await vi.waitFor(() => expect(res.events()).toContain("run"));
    stream.close();
    expect(res.ended).toBe(true);
  });
});
