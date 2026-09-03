// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/**
 * Specs for `useWorkflowProgress`.
 *
 * Driven through a stubbed `fetch` and the hook's OWN lazily-built client rather
 * than an injected fake, for two reasons: it needs no cast (a one-method double
 * is not a `WorkflowApi`, and asserting through one would mean laundering it),
 * and it covers the default-client path a page that passes no `api` takes.
 * `workflow-client.test.ts` owns what the request looks like; what is asserted
 * here is the STREAM.
 *
 * The property most worth pinning is that "the agent serves no progress route" is
 * told apart from "the run has written nothing yet". Those are indistinguishable
 * from the accumulated list, which is the whole reason `supported` exists.
 */

import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useWorkflowProgress } from "./use-workflow-progress.ts";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

/** An SSE response whose body is `frames`, delivered in one chunk. */
function sse(frames: string, status = 200): Response {
  return new Response(new TextEncoder().encode(frames), {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/** The `event: chunk` / `event: done` framing the route really emits. */
function chunks(lines: readonly string[], complete = true): string {
  const body = lines.map((line) => `event: chunk\ndata: ${JSON.stringify(line)}\n\n`).join("");
  return `${body}event: done\ndata: {"runId":"wrun_1","complete":${complete}}\n\n`;
}

/** The URL and init of the nth request the hook's client made. */
function call(n = 0): [string, RequestInit | undefined] {
  return fetchMock.mock.calls[n] as [string, RequestInit | undefined];
}

/**
 * A route that really HONOURS the cursor, over a log that grows between polls.
 *
 * A mock that answers a fixed script regardless of `startIndex` cannot tell a
 * correct cursor from an off-by-one, which is exactly how the re-open spec below
 * asserted `startIndex=1` for months while the server it talks to would have
 * answered that with chunk 1 skipped. So this serves out of a log the way
 * `workflow-api-stream.ts` does: an absent or non-negative `startIndex` is an
 * INCLUSIVE floor, and the read is bounded by the tail at the moment it arrived.
 *
 * `packages/aai-runtime/src/workflow-stream-cursor.test.ts` is the property over
 * every schedule; this is the one shape a reader can check by eye.
 */
function servingRoute(schedule: readonly (readonly string[])[]): { written: string[] } {
  const written: string[] = [];
  let poll = 0;
  fetchMock.mockImplementation(async (url: string) => {
    written.push(...(schedule[poll] ?? []));
    const complete = poll >= schedule.length - 1;
    poll += 1;
    const raw = new URL(url).searchParams.get("startIndex");
    // One `slice` covers both readings with nothing dropped from the front: a
    // non-negative INCLUSIVE floor and a negative count-back are the same
    // expression. The real store subtracts its first retained index; there is no
    // cap here, so that index is 0.
    const from = raw === null ? 0 : Number(raw);
    return sse(chunks(written.slice(from), complete));
  });
  return { written };
}

describe("useWorkflowProgress", () => {
  test("accumulates the run's chunks in order and stops on done", async () => {
    fetchMock.mockImplementation(async () => sse(chunks(["Reading…", "Filing."])));
    const { result } = renderHook(() => useWorkflowProgress("wrun_1"));

    await waitFor(() => expect(result.current.streaming).toBe(false));
    expect(result.current.progress).toEqual(["Reading…", "Filing."]);
    // `latest` is what a one-line status renders, rather than the whole log.
    expect(result.current.latest).toBe("Filing.");
    expect(result.current.supported).toBe(true);
  });

  test("an agent that does not serve the route reports UNSUPPORTED, not empty", async () => {
    // The distinction this hook exists to make: a 404 and a run that has written
    // nothing both leave `progress` empty, and a page needs to hide the section in
    // the first case and keep waiting in the second.
    fetchMock.mockImplementation(async () => new Response(null, { status: 404 }));
    const { result } = renderHook(() => useWorkflowProgress("wrun_1"));

    await waitFor(() => expect(result.current.supported).toBe(false));
    expect(result.current.progress).toEqual([]);
    expect(result.current.streaming).toBe(false);
  });

  test("keeps reading while the run is live, resuming past what it has seen", async () => {
    // The re-open loop, which is what a bounded read makes necessary: the first
    // answer is `complete: false`, so the hook comes back for more — and asks
    // from the index it got to rather than re-reading the whole log.
    //
    // Served by a route that HONOURS the cursor, so the accumulated list is the
    // assertion and `startIndex=1` is only the evidence. Against the fixed
    // two-response script this used to use, "one","two" came back whatever the
    // hook asked for: the URL assertion pinned an inclusive cursor while the real
    // store treated it as exclusive and would have dropped "two" entirely.
    servingRoute([["one"], ["two"]]);
    const { result } = renderHook(() => useWorkflowProgress("wrun_1", { intervalMs: 1 }));

    await waitFor(() => expect(result.current.streaming).toBe(false));
    expect(result.current.progress).toEqual(["one", "two"]);
    // The second read resumed from index 1 — the first index it had NOT seen. A
    // re-read from 0 would duplicate; reading it as exclusive would lose "two".
    expect(call(1)[0]).toContain("startIndex=1");
  });

  test("a dropped read is RETRIED rather than treated as the end", async () => {
    // No `done` frame is a dropped connection, not an absent route and not a
    // finished run. Retrying is what keeps a live run's log arriving.
    fetchMock
      .mockImplementationOnce(async () => sse('event: chunk\ndata: "half"\n\n'))
      .mockImplementationOnce(async () => sse(chunks(["rest"], true)));
    const { result } = renderHook(() => useWorkflowProgress("wrun_1", { intervalMs: 1 }));

    await waitFor(() => expect(result.current.streaming).toBe(false));
    expect(result.current.progress).toEqual(["half", "rest"]);
    expect(result.current.supported).toBe(true);
  });

  test("a TRANSIENT status is retried, and the line lands while the run is still live", async () => {
    // The defect this pins, reported against `transcription-workflow`'s batch
    // mode: a single 503 made the page show a bare "Transcribing…" for the whole
    // run, and the narration then appeared all at once afterwards (from a fresh
    // reader — a reload, or the finished run expanded in "Previous runs").
    //
    // Read as "this agent serves no progress route", a 503 set `supported:
    // false` and STOPPED the loop — permanently, for a live run, on the strength
    // of one failed request. `readOnce`'s own `catch` already said a transport
    // failure "is not a reason to stop watching a live run" (and the spec below
    // pins it); a 503 is that same failure with a status attached, and on the
    // platform these reads are brokered, so it is not an exotic answer.
    // `transcribeBatch` is where it surfaced because it is the longest-lived of
    // that template's three runs and so makes the most reads — exposure, not
    // anything about the flow.
    //
    // What is asserted is the ORDERING, not that a line eventually exists: the
    // run answers `complete: false` throughout, so `streaming` is still true
    // when the line arrives. A spec that only read the final list would pass
    // against the bug, since the bug loses nothing a LATER reader cannot see.
    fetchMock
      .mockImplementationOnce(async () => new Response(null, { status: 503 }))
      .mockImplementation(async (url: string) =>
        sse(
          new URL(url).searchParams.has("startIndex")
            ? chunks([], false)
            : chunks(["Uploading recording.wav to the async API."], false),
        ),
      );
    const { result } = renderHook(() => useWorkflowProgress("wrun_1", { intervalMs: 1 }));

    await waitFor(() =>
      expect(result.current.progress).toEqual(["Uploading recording.wav to the async API."]),
    );
    // Still in flight — the whole point. The run has not settled, and the reader
    // has not given up on it.
    expect(result.current.streaming).toBe(true);
    expect(result.current.supported).toBe(true);
  });

  test("a status that is NOT transient still reports the route absent", async () => {
    // The other half, so the fix above is a classification rather than "retry
    // everything": a 401 will answer the same way on every poll, and reading it
    // as a live run the page cannot see would broker a request every interval
    // for as long as the tab is open.
    fetchMock.mockImplementation(async () => new Response(null, { status: 401 }));
    const { result } = renderHook(() => useWorkflowProgress("wrun_1", { intervalMs: 1 }));

    await waitFor(() => expect(result.current.supported).toBe(false));
    expect(result.current.streaming).toBe(false);
  });

  test("a thrown fetch is retried too, and never reads as unsupported", async () => {
    fetchMock
      .mockImplementationOnce(() => Promise.reject(new Error("network down")))
      .mockImplementationOnce(async () => sse(chunks(["recovered"], true)));
    const { result } = renderHook(() => useWorkflowProgress("wrun_1", { intervalMs: 1 }));

    await waitFor(() => expect(result.current.streaming).toBe(false));
    expect(result.current.progress).toEqual(["recovered"]);
    expect(result.current.supported).toBe(true);
  });

  test("`missing` ends the stream without claiming the route is absent", async () => {
    fetchMock.mockImplementation(async () => sse('event: missing\ndata: {"runId":"gone"}\n\n'));
    const { result } = renderHook(() => useWorkflowProgress("gone"));

    await waitFor(() => expect(result.current.streaming).toBe(false));
    expect(result.current.supported).toBe(true);
  });

  test("a frame split across chunk boundaries is still parsed whole", async () => {
    // The one thing a naive split gets wrong, and the reason the parser buffers.
    fetchMock.mockImplementation(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(encoder.encode('event: chunk\ndata: "split '));
              controller.enqueue(encoder.encode('frame"\n\nevent: done\ndata: {}\n\n'));
              controller.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
    );
    const { result } = renderHook(() => useWorkflowProgress("wrun_1"));

    await waitFor(() => expect(result.current.progress).toEqual(["split frame"]));
  });

  test("no run id opens no stream at all", () => {
    const { result } = renderHook(() => useWorkflowProgress(undefined));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.streaming).toBe(false);
    expect(result.current.progress).toEqual([]);
  });

  test("a new id drops the previous run's lines rather than showing them", async () => {
    // The frame this covers reads as "the new run already finished": the old run's
    // completed log under a run that has just started. The stub answers PER ID,
    // which is what makes the assertion mean anything — one body for both ids
    // cannot tell a cleared list from a refilled one.
    fetchMock.mockImplementation(async (url: string) =>
      sse(chunks([url.includes("wrun_2") ? "log for wrun_2" : "log for wrun_1"])),
    );
    const { result, rerender } = renderHook(({ id }) => useWorkflowProgress(id), {
      initialProps: { id: "wrun_1" },
    });
    await waitFor(() => expect(result.current.progress).toEqual(["log for wrun_1"]));

    rerender({ id: "wrun_2" });
    // Cleared synchronously on the id change, before the new stream answers.
    expect(result.current.progress).toEqual([]);
    await waitFor(() => expect(result.current.progress).toEqual(["log for wrun_2"]));
  });

  test("namespace and a positive startIndex reach the URL", async () => {
    fetchMock.mockImplementation(async () => sse(chunks([])));
    renderHook(() => useWorkflowProgress("wrun_1", { namespace: "logs", startIndex: 4 }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(call()[0]).toContain("namespace=logs");
    expect(call()[0]).toContain("startIndex=4");
  });

  test("a negative startIndex is resolved HERE, so a re-open cannot duplicate", async () => {
    // "the last N" names no position a later read can resume from — the tail it
    // counts back from moves. Carried, the re-open asked from 0 and dropped
    // `seen` chunks off the FRONT, which is a different set entirely: lines the
    // caller never asked for, followed by the ones it already had, in that
    // order. So the first read is issued from 0 and trimmed to the window, and
    // every read after it is the ordinary absolute case.
    fetchMock
      .mockImplementationOnce(async () => sse(chunks(["a", "b", "c", "d", "e"], false)))
      .mockImplementationOnce(async () => sse(chunks(["f"], true)));
    const { result } = renderHook(() =>
      useWorkflowProgress("wrun_1", { startIndex: -2, intervalMs: 1 }),
    );

    await waitFor(() => expect(result.current.streaming).toBe(false));
    expect(result.current.progress).toEqual(["d", "e", "f"]);
    // The window is applied by the reader, so the route sees no negative index…
    expect(call(0)[0]).toBe("http://localhost:3000/workflows/runs/wrun_1/stream");
    // …and the re-open resumes from an absolute position past the whole log.
    expect(call(1)[0]).toContain("startIndex=5");
  });

  test("options the caller left out put nothing on the query string", async () => {
    // `exactOptionalPropertyTypes` makes present-and-undefined a different thing
    // from absent, and a spread would send `namespace=undefined`.
    fetchMock.mockImplementation(async () => sse(chunks([])));
    renderHook(() => useWorkflowProgress("wrun_1"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(call()[0]).toBe("http://localhost:3000/workflows/runs/wrun_1/stream");
  });

  test("unmounting aborts the stream", async () => {
    fetchMock.mockImplementation(async () => sse(chunks([])));
    const { unmount } = renderHook(() => useWorkflowProgress("wrun_1"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const signal = call()[1]?.signal;
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
  });
});
