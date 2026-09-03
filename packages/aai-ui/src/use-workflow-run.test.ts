// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/**
 * Specs for `useWorkflowRun`.
 *
 * The client the hook drives is faked here — `workflow-client.test.ts` owns what
 * a request looks like — so what is asserted is only the LOOP: whether a poll
 * re-arms, whether it stops on a terminal status, and whether a stale id is
 * abandoned rather than polled for the life of the tab. The stream half it tries
 * first is specced in `workflow-events.test.ts`; the client faked below declines
 * it, which is the path a test can drive.
 *
 * Virtual time throughout, because every one of those observes a timer.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createMockWorkflowApi, workflowRun as run } from "./_react-test-utils.ts";
import { DEFAULT_WORKFLOW_POLL_MS, MAX_MISSING_READS, useWorkflowRun } from "./use-workflow-run.ts";
import type { WorkflowApi } from "./workflow-client.ts";

/** A JSON response, as `fetch` resolves one. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * `fetch` is stubbed for every spec, not only the one that reaches it: an
 * unstubbed call would hit the jsdom origin and fail slowly rather than loudly.
 */
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

/** The URL and init of the nth request the lazily-built client made. */
function call(n = 0): [string, RequestInit | undefined] {
  return fetchMock.mock.calls[n] as [string, RequestInit | undefined];
}

describe("useWorkflowRun", () => {
  /**
   * A client whose `watch` always declines, so the hook falls back to the poll.
   * The stream half is specced in `workflow-events.test.ts`.
   */
  function pollingApi(get: WorkflowApi["get"]): WorkflowApi {
    return createMockWorkflowApi({
      get,
      startAndWait: vi.fn(async () => {
        throw new Error("not used by the poll fallback");
      }),
      cancel: vi.fn(async () => false),
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("an undefined runId reads as not-polling and costs nothing", () => {
    const api = pollingApi(vi.fn(async () => undefined));
    const { result } = renderHook(() => useWorkflowRun(undefined, { api }));
    expect(result.current).toEqual({ run: undefined, error: undefined, polling: false });
    expect(api.get).not.toHaveBeenCalled();
  });

  test("reports the run and STOPS once it is terminal", async () => {
    const get = vi
      .fn<WorkflowApi["get"]>()
      .mockResolvedValueOnce(run())
      .mockResolvedValue(run({ status: "completed", output: { ok: true } }));
    const { result } = renderHook(() =>
      useWorkflowRun<{ ok: boolean }>("wrun_1", { api: pollingApi(get) }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.run?.status).toBe("running");
    expect(result.current.polling).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEFAULT_WORKFLOW_POLL_MS);
    });
    expect(result.current.run?.status).toBe("completed");
    expect(result.current.polling).toBe(false);

    // A finished run costs nothing for as long as the page stays open.
    const settled = get.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEFAULT_WORKFLOW_POLL_MS * 5);
    });
    expect(get).toHaveBeenCalledTimes(settled);
  });

  test("gives up on an id the agent keeps reporting as unknown", async () => {
    // A 404 is a STABLE answer, so the budget absorbs a first read racing the
    // run's creation and nothing more — unbounded, a stale id polls (and, on the
    // platform, BROKERS) for as long as the tab is open.
    const get = vi.fn<WorkflowApi["get"]>().mockResolvedValue(undefined);
    const { result } = renderHook(() => useWorkflowRun("stale", { api: pollingApi(get) }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEFAULT_WORKFLOW_POLL_MS * MAX_MISSING_READS);
    });
    expect(get).toHaveBeenCalledTimes(MAX_MISSING_READS);
    expect(result.current.error).toBe("No workflow run stale");
    // `run` stays undefined, which reads as "still waiting" — so `polling` has
    // to come from the stop, not from the snapshot.
    expect(result.current.polling).toBe(false);
  });

  test("a failed read is reported and RETRIED, not fatal", async () => {
    // A dropped request against a booting sandbox is the common case; giving up
    // would strand a live run.
    const get = vi
      .fn<WorkflowApi["get"]>()
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockResolvedValue(run({ status: "completed", output: 1 }));
    const { result } = renderHook(() => useWorkflowRun("wrun_1", { api: pollingApi(get) }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.error).toBe("Failed to fetch");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEFAULT_WORKFLOW_POLL_MS);
    });
    // Cleared by the next successful read.
    expect(result.current.error).toBeUndefined();
    expect(result.current.run?.status).toBe("completed");
  });

  test("a new id does not show the previous run's state for a frame", async () => {
    const get = vi
      .fn<WorkflowApi["get"]>()
      .mockResolvedValueOnce(run({ status: "completed", output: 1 }));
    const api = pollingApi(get);
    const { result, rerender } = renderHook(({ id }) => useWorkflowRun(id, { api }), {
      initialProps: { id: "wrun_1" as string | undefined },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.run?.status).toBe("completed");
    get.mockImplementation(async () => undefined);
    rerender({ id: "wrun_2" });
    expect(result.current.run).toBeUndefined();
  });

  test("a fresh client object per render does NOT restart the watch", async () => {
    // The natural spelling passes a new object every render; as an effect
    // dependency that is an unbounded request loop against the agent, with
    // `error` wiped before anything can read it.
    const get = vi.fn<WorkflowApi["get"]>().mockResolvedValue(run());
    const { rerender } = renderHook(() => useWorkflowRun("wrun_1", { api: pollingApi(get) }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const after = get.mock.calls.length;
    rerender();
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(get).toHaveBeenCalledTimes(after);
  });

  test("unmounting stops the poll", async () => {
    const get = vi.fn<WorkflowApi["get"]>().mockResolvedValue(run());
    const { unmount } = renderHook(() => useWorkflowRun("wrun_1", { api: pollingApi(get) }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    unmount();
    const after = get.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEFAULT_WORKFLOW_POLL_MS * 5);
    });
    expect(get).toHaveBeenCalledTimes(after);
  });

  test("the client is resolved PER READ, so a token arriving later is picked up", async () => {
    const first = vi.fn<WorkflowApi["get"]>().mockResolvedValue(run());
    const second = vi.fn<WorkflowApi["get"]>().mockResolvedValue(run({ status: "cancelled" }));
    const { rerender } = renderHook(
      ({ get }) => useWorkflowRun("wrun_1", { api: pollingApi(get) }),
      {
        initialProps: { get: first },
      },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    rerender({ get: second });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEFAULT_WORKFLOW_POLL_MS);
    });
    expect(second).toHaveBeenCalled();
  });

  test("with no client it builds one lazily against the page's own origin", async () => {
    // The `/events` stream declines, so this also covers the fallback to the
    // poll end to end — through the real client rather than a double.
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/events")
        ? new Response(null, { status: 404 })
        : json(run({ status: "completed", output: 1 })),
    );
    const { result } = renderHook(() => useWorkflowRun("wrun_1"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.run?.status).toBe("completed");
    expect(String(call(0)[0])).toContain("/workflows/runs/wrun_1");
  });
});
