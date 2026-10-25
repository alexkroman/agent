// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/**
 * The two fields a submission reports ABOUT itself rather than about the run:
 * `timing` (press to settle) and `scope` (who finds the run again). Its own
 * file beside `use-workflow-form.test.ts`, which is near the test-length cap
 * and is about the glue; these are about what the glue says of itself.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createMockWorkflowApi, refuseNetwork, workflowRun as run } from "./_react-test-utils.ts";
import type { TestWorkflow } from "./_workflow-test-defs.ts";
import { useWorkflowSubmit } from "./use-workflow-form.ts";
import { useWorkflowStream } from "./use-workflow-stream.ts";
import type { WorkflowApi, WorkflowRun } from "./workflow-client.ts";

const POLL_MS = 5;

function fakeApi(over: Partial<WorkflowApi> = {}): WorkflowApi {
  return createMockWorkflowApi({
    list: vi.fn(async () => [{ name: "digest" }]),
    get: vi.fn(async () => run({ status: "completed" })),
    ...over,
  });
}

beforeEach(refuseNetwork);

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
});

describe("useWorkflowSubmit — timing", () => {
  test("marks the press at submit() and the settle when the run is over", async () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(100);
    // The run stays running until the spec lets it finish, so the settle mark
    // is measured at a clock reading the spec chose.
    const settled = Promise.withResolvers<WorkflowRun>();
    let reads = 0;
    const api = fakeApi({
      get: vi.fn(async () => (++reads === 1 ? run({ status: "running" }) : await settled.promise)),
    });
    const { result } = renderHook(() =>
      useWorkflowSubmit<TestWorkflow>("digest", { api, intervalMs: POLL_MS }),
    );
    expect(result.current.timing).toEqual({});

    now.mockReturnValue(250);
    await act(() => result.current.submit({}));
    expect(result.current.timing.submittedAt).toBe(250);
    await waitFor(() => expect(result.current.run?.status).toBe("running"));
    expect(result.current.timing.settledAt).toBeUndefined();

    now.mockReturnValue(900);
    settled.resolve(run({ status: "completed" }));
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.timing).toEqual({ submittedAt: 250, settledAt: 900 });

    act(() => result.current.reset());
    expect(result.current.timing).toEqual({});
  });

  test("a rejected submit settles the clock too — the wait is over either way", async () => {
    const api = fakeApi({
      start: vi.fn(async () => {
        throw new Error("url: invalid");
      }),
    });
    const { result } = renderHook(() =>
      useWorkflowSubmit<TestWorkflow>("digest", { api, intervalMs: POLL_MS }),
    );
    await act(() => result.current.submit({}));
    await waitFor(() => expect(result.current.timing.settledAt).toBeTypeOf("number"));
    expect(result.current.error).toBe("url: invalid");
  });
});

describe("useWorkflowSubmit — scope", () => {
  test("is the tab by default, and the browser for a local key, which it mints there", () => {
    const tab = renderHook(() => useWorkflowSubmit<TestWorkflow>("digest", { api: fakeApi() }));
    expect(tab.result.current.scope).toBe("tab");
    expect(localStorage.length).toBe(0);
    const browser = renderHook(() =>
      useWorkflowSubmit<TestWorkflow>("digest", { api: fakeApi(), key: { storage: "local" } }),
    );
    expect(browser.result.current.scope).toBe("browser");
    expect(localStorage.length).toBe(1);
  });

  test("a page-supplied key is at least browser-wide; recover: false is nobody's", () => {
    const own = renderHook(() =>
      useWorkflowSubmit<TestWorkflow>("digest", { api: fakeApi(), key: "account-7" }),
    );
    expect(own.result.current.scope).toBe("browser");
    const none = renderHook(() =>
      useWorkflowSubmit<TestWorkflow>("digest", { api: fakeApi(), recover: false }),
    );
    expect(none.result.current.scope).toBe("none");
  });

  test("a local key is the one recorded with the run", async () => {
    const api = fakeApi();
    const { result } = renderHook(() =>
      useWorkflowSubmit<TestWorkflow>("digest", { api, key: { storage: "local" } }),
    );
    await act(() => result.current.submit({}));
    const minted = localStorage.getItem(localStorage.key(0) ?? "");
    expect(api.start).toHaveBeenCalledWith("digest", {}, { key: minted });
  });
});

describe("useWorkflowStream — timing and scope", () => {
  test("reports scope none, and times the press through the upload to the settle", async () => {
    const api = createMockWorkflowApi({
      list: vi.fn(async () => [{ name: "transcribe", uploads: ["recording"] }]),
      start: vi.fn(async () => "wrun_1"),
      uploadStream: vi.fn(async (id: string) => ({
        id,
        name: "",
        type: "",
        size: 3,
        complete: true,
        url: `/u/${id}`,
      })),
      get: vi.fn(async () => run({ runId: "wrun_1", status: "completed" })),
    });
    const { result } = renderHook(() =>
      useWorkflowStream<TestWorkflow>("transcribe", { api, intervalMs: POLL_MS }),
    );
    expect(result.current.scope).toBe("none");
    await act(() => result.current.submit({ recording: new File(["abc"], "a.wav") }));
    expect(result.current.timing.submittedAt).toBeTypeOf("number");
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.timing.settledAt).toBeTypeOf("number");
  });
});
