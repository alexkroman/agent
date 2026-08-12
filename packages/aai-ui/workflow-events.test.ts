// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
/**
 * `useWorkflowRun`'s PUSH path — the SSE stream and every way it hands back to the
 * poll.
 *
 * Its own file because `workflow-client.test.ts` reached the 700-line test cap. The
 * seam is the one the hook itself draws: those specs drive the poll (their `fakeApi`
 * answers 404 on `watch`, the way an agent deployed before the route existed does),
 * and these drive the stream. What they mostly assert is the FALLBACK, because a
 * stream is an optimisation over a mechanism that already works and every way it
 * fails has to degrade to the thing that does.
 */

import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useWorkflowRun, type WorkflowApi, type WorkflowRun } from "./workflow-client.ts";

/** A `WorkflowApi` with only what these specs call, plus a scripted `watch`. */
function fakeApi(get: WorkflowApi["get"], watch?: WorkflowApi["watch"]): WorkflowApi {
  return {
    get,
    watch: watch ?? (() => Promise.resolve(new Response(null, { status: 404 }))),
    list: () => Promise.reject(new Error("unused")),
    start: () => Promise.reject(new Error("unused")),
    find: () => Promise.reject(new Error("unused")),
    recent: () => Promise.reject(new Error("unused")),
    cancel: () => Promise.reject(new Error("unused")),
    retry: () => Promise.reject(new Error("unused")),
    upload: () => Promise.reject(new Error("unused")),
  };
}

describe("useWorkflowRun over SSE", () => {
  /** A `Response` whose body streams `frames` as server-sent events. */
  function sse(...frames: string[]): Response {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }

  const frame = (event: string, data: unknown) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  it("takes its state from the stream, without polling at all", async () => {
    // The point of the stream: on the platform every polled read BROKERS, so a
    // page that streams must not also poll.
    const get = vi.fn<WorkflowApi["get"]>();
    const api = fakeApi(get, () =>
      Promise.resolve(
        sse(
          frame("run", { runId: "r1", status: "running", workflow: "w", stepsCompleted: 1 }),
          frame("run", { runId: "r1", status: "completed", workflow: "w", stepsCompleted: 2 }),
          frame("done", { runId: "r1" }),
        ),
      ),
    );
    const { result } = renderHook(() => useWorkflowRun("r1", { api, intervalMs: 5 }));

    await waitFor(() => expect(result.current.run?.status).toBe("completed"));
    expect(get).not.toHaveBeenCalled();
    // `done` is final, so the hook stops rather than reconnecting.
    await waitFor(() => expect(result.current.polling).toBe(false));
  });

  it("handles a frame split across chunk boundaries", async () => {
    // A frame is not guaranteed to arrive whole, and a naive split on the
    // terminator would drop or corrupt one — silently, as a page that stops
    // updating.
    const whole = frame("run", {
      runId: "r1",
      status: "completed",
      workflow: "w",
      stepsCompleted: 0,
    });
    const api = fakeApi(vi.fn(), () =>
      Promise.resolve(sse(whole.slice(0, 12), whole.slice(12), frame("done", { runId: "r1" }))),
    );
    const { result } = renderHook(() => useWorkflowRun("r1", { api }));
    await waitFor(() => expect(result.current.run?.status).toBe("completed"));
  });

  it("falls back to polling when the agent serves no /events route", async () => {
    // The ordinary case for an agent deployed before the route existed, and the
    // reason the poll stays the mechanism rather than being replaced.
    const get = vi.fn<WorkflowApi["get"]>().mockResolvedValue({
      runId: "r1",
      status: "completed",
      workflow: "w",
      stepsCompleted: 0,
    } as WorkflowRun);
    const api = fakeApi(get, () => Promise.resolve(new Response(null, { status: 404 })));
    const { result } = renderHook(() => useWorkflowRun("r1", { api, intervalMs: 5 }));

    await waitFor(() => expect(result.current.run?.status).toBe("completed"));
    expect(get).toHaveBeenCalled();
  });

  it("falls back when the stream ends without settling the run", async () => {
    // A dropped connection: the run is still live, so something has to keep
    // watching it.
    const get = vi.fn<WorkflowApi["get"]>().mockResolvedValue({
      runId: "r1",
      status: "completed",
      workflow: "w",
      stepsCompleted: 0,
    } as WorkflowRun);
    const api = fakeApi(get, () =>
      Promise.resolve(
        sse(frame("run", { runId: "r1", status: "running", workflow: "w", stepsCompleted: 0 })),
      ),
    );
    const { result } = renderHook(() => useWorkflowRun("r1", { api, intervalMs: 5 }));
    await waitFor(() => expect(result.current.run?.status).toBe("completed"));
    expect(get).toHaveBeenCalled();
  });

  it("stops on `missing` without falling back — a 404 is a stable answer", async () => {
    const get = vi.fn<WorkflowApi["get"]>();
    const api = fakeApi(get, () => Promise.resolve(sse(frame("missing", { runId: "gone" }))));
    const { result } = renderHook(() => useWorkflowRun("gone", { api, intervalMs: 5 }));

    await waitFor(() => expect(result.current.polling).toBe(false));
    // Polling an id the agent will never know is what the bound on missing reads
    // exists to prevent; the stream says so outright, so there is nothing to poll.
    expect(get).not.toHaveBeenCalled();
  });
});
