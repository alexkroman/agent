// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/**
 * `useWorkflows` and `useWorkflowSubmit`.
 *
 * Both are glue — the transport is `createWorkflowApi`'s and the watching is
 * `useWorkflowRun`'s, each specced next door — so what is asserted here is only
 * what the glue itself decides: when `pending` is true, which failure wins, and
 * that a new submit cannot leave the previous run's result on screen.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useWorkflowSubmit, useWorkflows } from "./use-workflow-form.ts";
import { MAX_MISSING_READS } from "./use-workflow-run.ts";
import type { WorkflowApi, WorkflowRun } from "./workflow-client.ts";

/**
 * Poll interval for the specs that watch a run settle.
 *
 * Real time rather than fake timers: these assert React state transitions
 * through `waitFor`, and the default 2s interval would put the second read past
 * every one of its budgets. The interval is not what is under test here — the
 * hook that owns it has its own virtual-time specs.
 */
const POLL_MS = 5;

function run(over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    runId: "wrun_1",
    workflow: "digest",
    createdAt: 0,
    status: "running",
    ...over,
  } as WorkflowRun;
}

/**
 * A client whose `watch` always declines, so the hook under test falls through
 * to `useWorkflowRun`'s poll — the path a test can drive.
 */
function fakeApi(over: Partial<WorkflowApi> = {}): WorkflowApi {
  return {
    upload: vi.fn(async () => ({
      id: "upl_1",
      name: "",
      type: "",
      size: 0,
      url: "/uploads/upl_1",
    })),
    list: vi.fn(async () => [{ name: "digest" }]),
    start: vi.fn(async () => "wrun_1"),
    startAndWait: vi.fn(async () => run({ status: "completed" })),
    get: vi.fn(async () => run({ status: "completed" })),
    find: vi.fn(async () => []),
    recent: vi.fn(async () => []),
    cancel: vi.fn(async () => true),
    watch: vi.fn(async () => new Response(null, { status: 404 })),
    streamOutput: vi.fn(async () => new Response(null, { status: 404 })),
    wake: vi.fn(async () => 0),
    ...over,
  };
}

beforeEach(() => {
  // A real `fetch` must never be reachable: an unstubbed call would hit the
  // jsdom origin and fail slowly rather than loudly.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("no test may reach the network");
    }),
  );
});

describe("useWorkflows", () => {
  test("reports the declared workflows", async () => {
    const api = fakeApi();
    const { result } = renderHook(() => useWorkflows({ api }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.workflows).toEqual([{ name: "digest" }]);
  });

  test("reports a failure instead of an empty list that reads as 'none declared'", async () => {
    // The distinction matters because an empty list renders as a form with no
    // fields, which looks like a correct answer about a different agent.
    const api = fakeApi({
      list: vi.fn(async () => {
        throw new Error("agent unavailable");
      }),
    });
    const { result } = renderHook(() => useWorkflows({ api }));
    await waitFor(() => expect(result.current.error).toBe("agent unavailable"));
    expect(result.current.workflows).toEqual([]);
  });

  test("reads once, not once per render", async () => {
    // The client is held in a ref rather than named as a dependency; as a
    // dependency the natural call site re-reads on every render it causes.
    const api = fakeApi();
    const { result, rerender } = renderHook(() => useWorkflows({ api }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender();
    rerender();
    expect(api.list).toHaveBeenCalledTimes(1);
  });
});

describe("useWorkflowSubmit", () => {
  test("starts a run and follows it to completion", async () => {
    const api = fakeApi();
    const { result } = renderHook(() => useWorkflowSubmit("digest", { api, intervalMs: POLL_MS }));

    await act(() => result.current.submit({ url: "u" }));

    expect(api.start).toHaveBeenCalledWith("digest", { url: "u" }, {});
    await waitFor(() => expect(result.current.run?.status).toBe("completed"));
  });

  test("stays pending until the RUN finishes, not until the POST returns", async () => {
    // A run outlives its `POST`; a button that re-enabled on the response would
    // invite a second submission of work already in flight.
    const settled = Promise.withResolvers<WorkflowRun>();
    let reads = 0;
    const api = fakeApi({
      get: vi.fn(async () => (++reads === 1 ? run({ status: "running" }) : await settled.promise)),
    });
    const { result } = renderHook(() => useWorkflowSubmit("digest", { api, intervalMs: POLL_MS }));

    await act(() => result.current.submit({}));
    await waitFor(() => expect(result.current.run?.status).toBe("running"));
    expect(result.current.pending).toBe(true);

    settled.resolve(run({ status: "completed" }));
    await waitFor(() => expect(result.current.pending).toBe(false));
  });

  test("STORES a chosen file first and starts the run with its id", async () => {
    // A run input is journaled and replayed on every resume, so bytes may never
    // travel in one. This is the only place that holds both the file and the
    // client that can store it, which is why the substitution lives here rather
    // than in every page with a file field.
    const api = fakeApi();
    const file = new File(["abc"], "standup.wav", { type: "audio/wav" });
    const { result } = renderHook(() => useWorkflowSubmit("digest", { api, intervalMs: POLL_MS }));

    await act(() => result.current.submit({ recording: file, languageCode: "en" }));

    expect(api.upload).toHaveBeenCalledWith(file);
    expect(api.start).toHaveBeenCalledWith(
      "digest",
      { recording: "upl_1", languageCode: "en" },
      {},
    );
  });

  test("stores every file of a multiple field, in order", async () => {
    const api = fakeApi();
    const files = [new File(["a"], "one.wav"), new File(["b"], "two.wav")];
    const { result } = renderHook(() => useWorkflowSubmit("digest", { api, intervalMs: POLL_MS }));

    await act(() => result.current.submit({ recordings: files }));

    expect(api.upload).toHaveBeenCalledTimes(2);
    expect(api.start).toHaveBeenCalledWith("digest", { recordings: ["upl_1", "upl_1"] }, {});
  });

  test("leaves an input with no files exactly as it was", async () => {
    const api = fakeApi();
    const { result } = renderHook(() => useWorkflowSubmit("digest", { api, intervalMs: POLL_MS }));

    await act(() => result.current.submit({ url: "u", count: 3, deep: true }));

    expect(api.upload).not.toHaveBeenCalled();
    expect(api.start).toHaveBeenCalledWith("digest", { url: "u", count: 3, deep: true }, {});
  });

  test("reports a failed upload as the submit's error, without starting a run", async () => {
    const api = fakeApi({
      upload: vi.fn(async () => {
        throw new Error("upload exceeds 268435456 bytes");
      }),
    });
    const { result } = renderHook(() => useWorkflowSubmit("digest", { api, intervalMs: POLL_MS }));

    await act(() => result.current.submit({ recording: new File(["a"], "big.wav") }));

    expect(api.start).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.error).toMatch(/268435456/));
  });

  test("passes a correlation key through when one is given", async () => {
    const api = fakeApi();
    const { result } = renderHook(() =>
      useWorkflowSubmit("digest", { api, key: "user-7", intervalMs: POLL_MS }),
    );
    await act(() => result.current.submit({}));
    expect(api.start).toHaveBeenCalledWith("digest", {}, { key: "user-7" });
  });

  test("uses the synchronous call when a wait is asked for, and follows the same id", async () => {
    const api = fakeApi({
      startAndWait: vi.fn(async () => run({ runId: "wrun_5", status: "completed" })),
    });
    const { result } = renderHook(() =>
      useWorkflowSubmit("digest", { api, wait: 5000, intervalMs: POLL_MS }),
    );

    await act(() => result.current.submit({}));

    expect(api.startAndWait).toHaveBeenCalledWith("digest", {}, { wait: 5000 });
    expect(api.start).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.run).toBeDefined());
  });

  test("surfaces a rejected input and starts nothing", async () => {
    const api = fakeApi({
      start: vi.fn(async () => {
        throw new Error("url: invalid");
      }),
    });
    const { result } = renderHook(() => useWorkflowSubmit("digest", { api, intervalMs: POLL_MS }));

    await act(() => result.current.submit({}));

    expect(result.current.error).toBe("url: invalid");
    expect(result.current.run).toBeUndefined();
    expect(result.current.pending).toBe(false);
  });

  test("drops the previous run before the next submit lands", async () => {
    // A finished result sitting under a form that is already submitting again
    // is the one wrong answer this hook can give, and it looks like a correct
    // one — which is why the id is dropped BEFORE the request rather than when
    // it returns.
    const api = fakeApi();
    const { result } = renderHook(() => useWorkflowSubmit("digest", { api, intervalMs: POLL_MS }));

    await act(() => result.current.submit({}));
    await waitFor(() => expect(result.current.run?.status).toBe("completed"));

    // A second submit whose request never settles: the previous run must be
    // gone regardless, because nothing has replaced it yet.
    const started = Promise.withResolvers<string>();
    vi.mocked(api.start).mockImplementationOnce(() => started.promise);
    // A SYNCHRONOUS `act` callback, deliberately: `submit` clears the run id
    // before its first await, and awaiting the returned promise here would
    // hang on a request the test is holding open on purpose.
    let second: Promise<void> | undefined;
    act(() => {
      second = result.current.submit({});
    });

    expect(result.current.run).toBeUndefined();
    expect(result.current.pending).toBe(true);

    started.resolve("wrun_2");
    await act(async () => {
      await second;
    });
  });

  test("stops being pending once the watch gives up on a run the agent never knew", async () => {
    // The regression: `pending` used to be re-derived from the snapshot as
    // `!isTerminal(run)`, and giving up past MAX_MISSING_READS leaves `run`
    // undefined — so the submit button stayed disabled and reading "Working…"
    // for the life of the page, with the correct error directly above it.
    const api = fakeApi({ get: vi.fn(async () => undefined) });
    const { result } = renderHook(() => useWorkflowSubmit("digest", { api, intervalMs: POLL_MS }));

    await act(() => result.current.submit({}));

    await waitFor(() => expect(result.current.error).toBe("No workflow run wrun_1"));
    expect(api.get).toHaveBeenCalledTimes(MAX_MISSING_READS);
    expect(result.current.run).toBeUndefined();
    expect(result.current.pending).toBe(false);
  });

  test("reset puts the form back to its initial state", async () => {
    const api = fakeApi();
    const { result } = renderHook(() => useWorkflowSubmit("digest", { api, intervalMs: POLL_MS }));

    await act(() => result.current.submit({}));
    await waitFor(() => expect(result.current.run).toBeDefined());

    act(() => result.current.reset());
    expect(result.current.run).toBeUndefined();
    expect(result.current.pending).toBe(false);
  });
});
