// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/**
 * `useSubmission` — the tail both submit hooks share.
 *
 * The pieces are specced next door (`_submission-state.test.ts`,
 * `_submission-timing.test.ts`, `_run-controls.test.ts`, `use-workflow-run.test.ts`),
 * and each hook's own body in its own spec. What is asserted here is only the
 * wiring this module decides: the order a press runs in, what the body is
 * handed, and what the assembled submission reports.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createMockWorkflowApi, refuseNetwork } from "./_react-test-utils.ts";
import { type BeginSubmission, useSubmission } from "./_submission.ts";
import { createUploadGate } from "./upload/index.ts";
import type { WorkflowApi } from "./workflow-client.ts";

beforeEach(refuseNetwork);

/** A body that starts `runId` at once and records what it was handed. */
function beginning(runId = "wrun_1") {
  const seen: { input: unknown; client: WorkflowApi }[] = [];
  const begin: BeginSubmission = (input, client) => {
    seen.push({ input, client });
    return {
      gate: createUploadGate(),
      work: async ({ started }) => {
        started(runId);
      },
    };
  };
  return { begin, seen };
}

/** The getter is stable across renders, as `useWorkflowApiRef`'s is. */
function mount(api: WorkflowApi, begin: BeginSubmission, scope: "tab" | "none" = "tab") {
  const getClient = () => api;
  return renderHook(() => useSubmission({ getClient, api, intervalMs: 5, scope, begin }));
}

describe("useSubmission", () => {
  test("a press marks the clock, then hands the body the input and the client", async () => {
    const api = createMockWorkflowApi();
    const now = vi.spyOn(performance, "now").mockReturnValue(1234);
    const { begin, seen } = beginning();
    const { result } = mount(api, begin);

    await act(async () => {
      // `submitForm` is `submit` (pinned below); the typed door takes `never`
      // on this untyped scaffold, the loose one takes any values.
      await result.current.submitForm({ url: "https://example.com" });
    });

    expect(seen).toEqual([{ input: { url: "https://example.com" }, client: api }]);
    expect(result.current.timing.submittedAt).toBe(1234);
    expect(result.current.startedHere).toBe(true);
    await waitFor(() => expect(result.current.run?.runId).toBe("wrun_1"));
    now.mockRestore();
  });

  test("submitForm is submit, and scope is echoed", () => {
    const api = createMockWorkflowApi();
    const { result } = mount(api, beginning().begin, "none");
    expect(result.current.submitForm).toBe(result.current.submit);
    expect(result.current.scope).toBe("none");
  });

  test("submit keeps its identity across renders while the body does", () => {
    const api = createMockWorkflowApi();
    const { begin } = beginning();
    const { result, rerender } = mount(api, begin);
    const first = result.current.submit;
    rerender();
    expect(result.current.submit).toBe(first);
  });

  test("reset drops the marks and puts the form back", async () => {
    const api = createMockWorkflowApi();
    const { result } = mount(api, beginning().begin);
    await act(async () => {
      await result.current.submitForm({});
    });
    expect(result.current.timing.submittedAt).toBeTypeOf("number");

    act(() => result.current.reset());
    expect(result.current.timing).toEqual({});
    expect(result.current.startedHere).toBe(false);
    expect(result.current.run).toBeUndefined();
  });

  test("the controls answer rather than fail before there is a run", async () => {
    const api = createMockWorkflowApi();
    const { result } = mount(api, beginning().begin);
    await expect(result.current.wake()).resolves.toBe(0);
    await expect(result.current.cancel()).resolves.toBe(false);
    expect(api.wake).not.toHaveBeenCalled();
  });

  test("the body's failure is the submission's error, with no run on the page", async () => {
    const api = createMockWorkflowApi();
    const begin: BeginSubmission = () => ({
      gate: createUploadGate(),
      work: async () => {
        throw new Error("refused");
      },
    });
    const { result } = mount(api, begin);
    await act(async () => {
      await result.current.submitForm({});
    });
    expect(result.current.error).toBe("refused");
    expect(result.current.pending).toBe(false);
    expect(result.current.run).toBeUndefined();
  });
});
