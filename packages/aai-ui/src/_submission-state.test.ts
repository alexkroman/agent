// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom
/**
 * `useSubmissionState` — the facade both submit hooks share over the form's
 * statechart.
 *
 * What is asserted is the BRIDGE, not the decisions (those are
 * `_workflow-form-state.test.ts`'s): that the lookup is busy from the first
 * frame and asked once per key, that `submit` resolves when its submission is
 * over, that unmounting abandons one in flight, and that the actions keep
 * their identity. The hooks' own walks are specced in
 * `use-workflow-form.test.ts` and `use-workflow-stream.test.ts`.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { createMockWorkflowApi, workflowRun as run } from "./_react-test-utils.ts";
import type { RecoverRunOptions } from "./_recover-run.ts";
import { useSubmissionState } from "./_submission-state.ts";
import { createUploadGate } from "./upload/index.ts";
import type { UploadStatus } from "./use-workflow-form.ts";
import type { WorkflowApi, WorkflowRun } from "./workflow-client.ts";

const BAR: UploadStatus = {
  name: "standup.wav",
  index: 1,
  count: 1,
  loaded: 10,
  total: 100,
  fraction: 0.1,
  paused: false,
};

const KEY = "7f3ad2c0-8b41-4d2e-9c15-6a0e3f5b1d77";

/** The facade with a lookup over `api`, re-rendered with a new key on demand. */
function renderRecovering(api: WorkflowApi, over: Partial<RecoverRunOptions> = {}) {
  const getClient = () => api;
  return renderHook(
    ({ key }: { key: string }) =>
      useSubmissionState({ workflow: "digest", key, enabled: true, getClient, ...over }),
    { initialProps: { key: KEY } },
  );
}

describe("useSubmissionState — the lookup", () => {
  test("is busy from the FIRST frame, and adopts the run it finds", async () => {
    const found = Promise.withResolvers<WorkflowRun[]>();
    const api = createMockWorkflowApi({ find: vi.fn(() => found.promise) });
    const { result } = renderRecovering(api);

    // No frame in which a page about to adopt a run reads as idle.
    expect(result.current.busy).toBe(true);
    await act(async () => {
      found.resolve([run({ runId: "wrun_9" })]);
      await found.promise;
    });
    await waitFor(() => expect(result.current.runId).toBe("wrun_9"));
    expect(result.current.busy).toBe(false);
    expect(api.find).toHaveBeenCalledExactlyOnceWith("digest", KEY, { limit: 1 });
  });

  test("`enabled: false` asks nothing and is never busy", () => {
    const api = createMockWorkflowApi();
    const { result } = renderRecovering(api, { enabled: false });
    expect(result.current.busy).toBe(false);
    expect(api.find).not.toHaveBeenCalled();
  });

  test("no lookup at all, for a hook that refuses one", () => {
    const { result } = renderHook(() => useSubmissionState());
    expect(result.current).toMatchObject({ busy: false, runId: undefined, startedHere: false });
  });

  test("a new KEY is a different person's run, and is asked about", async () => {
    const api = createMockWorkflowApi({ find: vi.fn(async () => []) });
    const { result, rerender } = renderRecovering(api);
    await waitFor(() => expect(result.current.busy).toBe(false));

    rerender({ key: "another-key" });
    await waitFor(() =>
      expect(api.find).toHaveBeenLastCalledWith("digest", "another-key", { limit: 1 }),
    );
    expect(api.find).toHaveBeenCalledTimes(2);
  });

  test("a re-render with the same key asks nothing more", async () => {
    const api = createMockWorkflowApi({ find: vi.fn(async () => []) });
    const { result, rerender } = renderRecovering(api);
    await waitFor(() => expect(result.current.busy).toBe(false));
    rerender({ key: KEY });
    rerender({ key: KEY });
    expect(api.find).toHaveBeenCalledOnce();
  });
});

describe("useSubmissionState — a submission", () => {
  test("submit runs the body and resolves once the submission is over", async () => {
    const { result } = renderHook(() => useSubmissionState());
    await act(() =>
      result.current.actions.submit(createUploadGate(), async ({ progress, started }) => {
        progress(BAR);
        started("wrun_1");
      }),
    );
    expect(result.current).toMatchObject({
      runId: "wrun_1",
      upload: undefined,
      startedHere: true,
      busy: false,
    });
  });

  test("a failed body is reported, and submit still resolves", async () => {
    const { result } = renderHook(() => useSubmissionState());
    await act(() =>
      result.current.actions.submit(createUploadGate(), async () => {
        throw new Error("url: invalid");
      }),
    );
    expect(result.current.startError).toBe("url: invalid");
  });

  test("pause and resume reach the LIVE submission's gate and the bar", async () => {
    const { result } = renderHook(() => useSubmissionState());
    const gate = createUploadGate();
    const end = Promise.withResolvers<void>();
    let submitted: Promise<void> = Promise.resolve();
    act(() => {
      submitted = result.current.actions.submit(gate, async ({ progress }) => {
        progress(BAR);
        await end.promise;
      });
    });

    act(() => result.current.actions.pauseUpload());
    expect(gate.paused).toBe(true);
    expect(result.current.upload?.paused).toBe(true);

    act(() => result.current.actions.resumeUpload());
    expect(gate.paused).toBe(false);
    expect(result.current.upload?.paused).toBe(false);

    end.resolve();
    await act(() => submitted);
  });

  test("unmounting abandons a submission in flight, and settles it", async () => {
    const { result, unmount } = renderHook(() => useSubmissionState());
    const gate = createUploadGate();
    let submitted: Promise<void> = Promise.resolve();
    act(() => {
      submitted = result.current.actions.submit(gate, async () => {
        await gate.settle();
        if (gate.cancelled) throw new Error("Upload cancelled.");
      });
    });
    act(() => result.current.actions.pauseUpload());

    unmount();
    expect(gate.cancelled).toBe(true);
    await expect(submitted).resolves.toBeUndefined();
  });

  test("the actions bag keeps its identity through state changes", async () => {
    // It is a dependency of each hook's `submit`; a bag that moved on every
    // progress report would rebuild the form's `onSubmit` with it.
    const { result } = renderHook(() => useSubmissionState());
    const actions = result.current.actions;
    await act(() =>
      actions.submit(createUploadGate(), async ({ progress, started }) => {
        progress(BAR);
        started("wrun_1");
      }),
    );
    expect(result.current.actions).toBe(actions);
  });
});
