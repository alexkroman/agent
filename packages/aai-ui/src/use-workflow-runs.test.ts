// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/**
 * Specs for `useWorkflowRuns` — the history list beside the form.
 *
 * Three claims: it reads the right route for the arguments it was given
 * (`recent` for a workflow, `find` when a key narrows it), it re-reads when a
 * page asks rather than on a clock of its own, and it REPORTS a failed read
 * instead of rendering an empty list, which would say "you have never run this"
 * about an agent that was merely unreachable.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { createMockWorkflowApi } from "./_react-test-utils.ts";
import { useWorkflowRuns } from "./use-workflow-runs.ts";
import type { WorkflowApi, WorkflowRun } from "./workflow-client.ts";

function run(over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    runId: "wrun_1",
    workflow: "transcribe",
    createdAt: 1_700_000_000_000,
    status: "completed",
    output: { source: "standup.wav" },
    ...over,
  } as WorkflowRun;
}

/**
 * A client whose every method is real — no cast.
 *
 * A laundering cast would keep compiling when the client GAINS a method,
 * leaving it `undefined` here — the failure a typed fake exists to prevent
 * (see `_test-utils.ts` in the root guide). The escape-hatch ratchet scans
 * plain substrings, so naming that cast in prose scores as one too.
 */
function fakeApi(over: Partial<WorkflowApi> = {}): WorkflowApi {
  return createMockWorkflowApi({
    startAndWait: vi.fn(async () => run()),
    get: vi.fn(async () => run()),
    find: vi.fn(async () => [run({ runId: "wrun_keyed" })]),
    recent: vi.fn(async () => [run()]),
    ...over,
  });
}

describe("useWorkflowRuns", () => {
  test("reads the workflow's recent runs", async () => {
    const api = fakeApi();
    const { result } = renderHook(() => useWorkflowRuns("transcribe", { api, limit: 10 }));

    await waitFor(() => expect(result.current.runs).toHaveLength(1));
    expect(api.recent).toHaveBeenCalledWith("transcribe", { limit: 10 });
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeUndefined();
  });

  test("narrows to a correlation key when one is given", async () => {
    const api = fakeApi();
    const { result } = renderHook(() => useWorkflowRuns("transcribe", { api, key: "caller-1" }));

    await waitFor(() => expect(result.current.runs[0]?.runId).toBe("wrun_keyed"));
    expect(api.find).toHaveBeenCalledWith("transcribe", "caller-1", undefined);
    expect(api.recent).not.toHaveBeenCalled();
  });

  test("re-reads on refresh, and not on a clock of its own", async () => {
    const api = fakeApi();
    const { result } = renderHook(() => useWorkflowRuns("transcribe", { api }));
    await waitFor(() => expect(result.current.runs).toHaveLength(1));
    expect(api.recent).toHaveBeenCalledTimes(1);

    await act(async () => result.current.refresh());
    await waitFor(() => expect(api.recent).toHaveBeenCalledTimes(2));
  });

  test("a refresh that overtakes a slower read in flight DROPS the older answer", async () => {
    // The epoch was bumped only by the effect's cleanup, so two refreshes
    // captured the same generation and whichever settled LAST won — which for a
    // "the run I just started has finished, re-read the list" refresh is
    // routinely the older, staler read.
    const slow = Promise.withResolvers<WorkflowRun[]>();
    const api = fakeApi({
      recent: vi
        .fn<WorkflowApi["recent"]>()
        .mockReturnValueOnce(slow.promise)
        .mockResolvedValue([run({ runId: "wrun_fresh" })]),
    });
    const { result } = renderHook(() => useWorkflowRuns("transcribe", { api }));

    // The second read answers first, with the newer list.
    await act(async () => result.current.refresh());
    await waitFor(() => expect(result.current.runs[0]?.runId).toBe("wrun_fresh"));

    // The first read lands late. It must not overwrite what replaced it.
    await act(async () => {
      slow.resolve([run({ runId: "wrun_stale" })]);
      await slow.promise;
    });
    expect(result.current.runs[0]?.runId).toBe("wrun_fresh");
  });

  test("reads nothing when it is skipped or has no workflow", () => {
    const api = fakeApi();
    renderHook(() => useWorkflowRuns("transcribe", { api, skip: true }));
    renderHook(() => useWorkflowRuns(undefined, { api }));
    expect(api.recent).not.toHaveBeenCalled();
  });

  test("REPORTS a failed read rather than rendering an empty history", async () => {
    const api = fakeApi({
      recent: vi.fn(async () => {
        throw new Error("agent unavailable");
      }),
    });
    const { result } = renderHook(() => useWorkflowRuns("transcribe", { api }));

    await waitFor(() => expect(result.current.error).toBe("agent unavailable"));
    expect(result.current.runs).toEqual([]);
    expect(result.current.loading).toBe(false);
  });
});
