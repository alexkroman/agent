// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/**
 * `useRunControls` — `wake()` and `cancel()`, bound to the run a hook follows.
 *
 * Two halves. The first drives the hook directly: no run is the SDK's own
 * "nothing happened" answer rather than a call, and the callbacks re-bind when
 * the run id moves. The second is the same contract as a page sees it through
 * `useWorkflowSubmit`, which is where the bound run id comes from (moved here
 * from `use-workflow-form.test.ts`; `use-workflow-stream.test.ts` keeps the one
 * spec that the streaming hook carries them too).
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createMockWorkflowApi, refuseNetwork, workflowRun as run } from "./_react-test-utils.ts";
import { useRunControls } from "./_run-controls.ts";
import type { TestWorkflow } from "./_workflow-test-defs.ts";
import { useWorkflowSubmit } from "./use-workflow-form.ts";
import type { WorkflowApi } from "./workflow-client.ts";

/** Short enough that the watch's first read lands inside a spec's budget. */
const POLL_MS = 5;

/** The sibling suite's client: `watch` declines, the reads answer completed. */
function fakeApi(over: Partial<WorkflowApi> = {}): WorkflowApi {
  return createMockWorkflowApi({
    list: vi.fn(async () => [{ name: "digest" }]),
    get: vi.fn(async () => run({ status: "completed" })),
    ...over,
  });
}

beforeEach(refuseNetwork);

afterEach(() => {
  // The default run key lives here for the life of the tab (`use-run-key.ts`).
  sessionStorage.clear();
});

describe("useRunControls", () => {
  test("no run is the no-op answer, and reaches no client", async () => {
    const api = fakeApi();
    const { result } = renderHook(() => useRunControls(undefined, () => api));

    await expect(result.current.wake()).resolves.toBe(0);
    await expect(result.current.cancel()).resolves.toBe(false);
    expect(api.wake).not.toHaveBeenCalled();
    expect(api.cancel).not.toHaveBeenCalled();
  });

  test("passes the client's own answers through for the bound run", async () => {
    const api = fakeApi({ wake: vi.fn(async () => 2), cancel: vi.fn(async () => true) });
    const { result } = renderHook(() => useRunControls("wrun_7", () => api));

    await expect(result.current.wake()).resolves.toBe(2);
    await expect(result.current.cancel()).resolves.toBe(true);
    expect(api.wake).toHaveBeenCalledWith("wrun_7");
    expect(api.cancel).toHaveBeenCalledWith("wrun_7");
  });

  test("the callbacks are stable while the run is, and re-bind when it moves", async () => {
    const api = fakeApi();
    const getClient = () => api;
    const { result, rerender } = renderHook(({ runId }) => useRunControls(runId, getClient), {
      initialProps: { runId: "wrun_1" as string | undefined },
    });
    const first = result.current;
    rerender({ runId: "wrun_1" });
    expect(result.current.wake).toBe(first.wake);
    expect(result.current.cancel).toBe(first.cancel);

    rerender({ runId: "wrun_2" });
    expect(result.current.wake).not.toBe(first.wake);
    await result.current.cancel();
    expect(api.cancel).toHaveBeenLastCalledWith("wrun_2");
  });

  test("the client is resolved per call, not captured with the run", async () => {
    const before = fakeApi();
    const after = fakeApi();
    let current = before;
    const { result } = renderHook(() => useRunControls("wrun_1", () => current));
    current = after;
    await result.current.wake();
    expect(after.wake).toHaveBeenCalledWith("wrun_1");
    expect(before.wake).not.toHaveBeenCalled();
  });
});

describe("useWorkflowSubmit: wake and cancel", () => {
  test("wake and cancel target the run this submission is following", async () => {
    // The whole reason a page holding this hook needed an `api` of its own: the
    // hook knew the run id and would not hand it back, so `link-digest-workflow` and
    // `podcast-digest-workflow` each keep a module-scope client purely to write
    // `api.wake(runId)`.
    const api = fakeApi({ get: vi.fn(async () => run({ status: "running" })) });
    const { result } = renderHook(() =>
      useWorkflowSubmit<TestWorkflow>("digest", { api, intervalMs: POLL_MS }),
    );

    await act(() => result.current.submit({ url: "u" }));
    await waitFor(() => expect(result.current.run?.status).toBe("running"));

    await act(async () => {
      await result.current.wake();
      await result.current.cancel();
    });
    expect(api.wake).toHaveBeenCalledWith("wrun_1");
    expect(api.cancel).toHaveBeenCalledWith("wrun_1");
  });

  test("both answer rather than fail before a run exists", async () => {
    // `0` sleeps ended and `false` "this call did not end it" are the SDK's own
    // answers for a run that had already moved on, so the no-run case is the
    // same answer rather than a branch every caller has to write.
    const api = fakeApi();
    const { result } = renderHook(() => useWorkflowSubmit<TestWorkflow>("digest", { api }));

    await expect(result.current.wake()).resolves.toBe(0);
    await expect(result.current.cancel()).resolves.toBe(false);
    expect(api.wake).not.toHaveBeenCalled();
    expect(api.cancel).not.toHaveBeenCalled();
  });

  test("wake reports how many sleeps it interrupted", async () => {
    const api = fakeApi({
      get: vi.fn(async () => run({ status: "running" })),
      wake: vi.fn(async () => 1),
    });
    const { result } = renderHook(() =>
      useWorkflowSubmit<TestWorkflow>("digest", { api, intervalMs: POLL_MS }),
    );

    await act(() => result.current.submit({}));
    await waitFor(() => expect(result.current.run?.status).toBe("running"));
    await expect(result.current.wake()).resolves.toBe(1);
  });

  test("reset() puts the FORM back, so the controls stop targeting the old run", async () => {
    // Distinct from `cancel()`, which stops the run and leaves the form where it
    // is. Confusing the two is how "clear this" becomes "throw the work away".
    const api = fakeApi({ get: vi.fn(async () => run({ status: "running" })) });
    const { result } = renderHook(() =>
      useWorkflowSubmit<TestWorkflow>("digest", { api, intervalMs: POLL_MS }),
    );

    await act(() => result.current.submit({}));
    await waitFor(() => expect(result.current.run?.status).toBe("running"));

    act(() => result.current.reset());
    await expect(result.current.cancel()).resolves.toBe(false);
    expect(api.cancel).not.toHaveBeenCalled();
  });
});
