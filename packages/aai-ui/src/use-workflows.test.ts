// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/**
 * `useWorkflows` — the agent's declared workflows, read once.
 *
 * Glue, like its former neighbour: the transport is `createWorkflowApi`'s, so
 * what is asserted here is only what the hook decides — that a failed lookup is
 * REPORTED rather than degraded to an empty list (which renders as a form with
 * no fields and reads as a correct answer about a different agent), and that
 * the read happens once rather than once per render.
 *
 * Its own file because the hook is its own module — see `use-workflows.ts` on
 * the split.
 */

import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createMockWorkflowApi, refuseNetwork, workflowRun as run } from "./_react-test-utils.ts";
import { useWorkflows } from "./use-workflows.ts";
import type { WorkflowApi } from "./workflow-client.ts";

/** The two reads these specs assert on; the shared builder covers the rest. */
function fakeApi(over: Partial<WorkflowApi> = {}): WorkflowApi {
  return createMockWorkflowApi({
    list: vi.fn(async () => [{ name: "digest" }]),
    get: vi.fn(async () => run({ status: "completed" })),
    ...over,
  });
}

beforeEach(refuseNetwork);

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
