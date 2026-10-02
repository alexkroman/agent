// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/**
 * `findRecoveredRun` — the lookup that finds a run again after the page lost
 * its id.
 *
 * Two halves. The first drives the lookup directly, for the question it asks
 * and the shape of its answer. WHEN it is asked — busy from the first frame,
 * `enabled: false`, a new KEY, an answer after unmount — is the form's
 * statechart's and its facade's (`_workflow-form-state.test.ts`,
 * `_submission-state.test.ts`). The second is the four decisions the module
 * doc lists, as a page sees them through `useWorkflowSubmit` — moved here from
 * `use-workflow-form-recover.test.ts`, which keeps the default-key specs.
 *
 * Every spec clears `sessionStorage` after it, because `useWorkflowSubmit`'s
 * default key lives there for the life of the tab.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createMockWorkflowApi, refuseNetwork, workflowRun as run } from "./_react-test-utils.ts";
import { findRecoveredRun } from "./_recover-run.ts";
import type { TestWorkflow } from "./_workflow-test-defs.ts";
import { useWorkflowSubmit } from "./use-workflow-form.ts";
import type { WorkflowApi, WorkflowRun } from "./workflow-client.ts";

/** Short enough that the poll's first re-read is never what a spec waits on. */
const POLL_MS = 5;

/** The key a page would have minted for itself — opaque, as the template's is. */
const KEY = "7f3ad2c0-8b41-4d2e-9c15-6a0e3f5b1d77";

/**
 * The default `get` ECHOES the id it was asked for, which the shared builder's
 * does not — and here that is the whole assertion: an adopted run is only
 * adopted if the watch that follows is watching THAT id.
 */
function fakeApi(over: Partial<WorkflowApi> = {}): WorkflowApi {
  return createMockWorkflowApi({
    get: vi.fn(async (runId: string) => run({ runId, status: "completed" })),
    ...over,
  });
}

/** The hook as a page holds it, with the reload knobs a spec varies. */
function renderSubmit(api: WorkflowApi, opts: { key?: string; recover?: boolean } = {}) {
  return renderHook(() =>
    useWorkflowSubmit<TestWorkflow>("digest", { api, intervalMs: POLL_MS, ...opts }),
  );
}

beforeEach(refuseNetwork);

afterEach(() => {
  // The default key lives here for the life of the tab — see the module doc.
  sessionStorage.clear();
});

describe("findRecoveredRun", () => {
  test("asks for the key's NEWEST run and answers its id", async () => {
    const api = fakeApi({ find: vi.fn(async () => [run({ runId: "wrun_9" })]) });
    await expect(findRecoveredRun(api, "digest", KEY)).resolves.toBe("wrun_9");
    // `limit: 1` because the newest run is the only one a form can show.
    expect(api.find).toHaveBeenCalledExactlyOnceWith("digest", KEY, { limit: 1 });
  });

  test("an empty answer is `undefined`, not a failure", async () => {
    const api = fakeApi({ find: vi.fn(async () => []) });
    await expect(findRecoveredRun(api, "digest", KEY)).resolves.toBeUndefined();
  });

  test("a failed lookup REJECTS, so the page can say so", async () => {
    const api = fakeApi({
      find: vi.fn(async () => {
        throw new Error("agent unavailable");
      }),
    });
    await expect(findRecoveredRun(api, "digest", KEY)).rejects.toMatchObject({
      message: "agent unavailable",
    });
  });
});

describe("useWorkflowSubmit — the lookup's decisions", () => {
  test("`recover: false` looks nothing up, and the run is lost with the page", async () => {
    const api = fakeApi({ find: vi.fn(async () => [run({ runId: "wrun_9" })]) });
    const first = renderSubmit(api, { recover: false });
    await act(() => first.result.current.submit({ url: "u" }));
    await waitFor(() => expect(first.result.current.run?.runId).toBe("wrun_1"));

    first.unmount();
    const second = renderSubmit(api, { recover: false });

    await waitFor(() => expect(second.result.current.pending).toBe(false));
    expect(second.result.current.run).toBeUndefined();
    // The opt-out is about the LOOKUP, and this is what it costs: the run is
    // still there and still recorded under the key, and this page will not ask.
    expect(api.find).not.toHaveBeenCalled();
    expect(vi.mocked(api.start).mock.calls[0]?.[2]?.key).toEqual(expect.any(String));
  });

  test("adopts the key's newest run on mount, so the reload finds it again", async () => {
    const api = fakeApi({
      find: vi.fn(async () => [run({ runId: "wrun_9", status: "running" })]),
    });
    const { result } = renderSubmit(api, { key: KEY, recover: true });

    await waitFor(() => expect(result.current.run?.runId).toBe("wrun_9"));
    // `limit: 1` because the newest run of this key is the only one a form can
    // show; the rest are `useWorkflowRuns`' subject.
    expect(api.find).toHaveBeenCalledWith("digest", KEY, { limit: 1 });
  });

  test("stays pending while it looks, so the form cannot start a second run", async () => {
    const found = Promise.withResolvers<WorkflowRun[]>();
    const api = fakeApi({ find: vi.fn(() => found.promise) });
    const { result } = renderSubmit(api, { key: KEY, recover: true });

    // The first frame, before any effect has settled: a page whose submit
    // button reads `pending` must not offer it while a live run is arriving.
    expect(result.current.pending).toBe(true);
    expect(result.current.run).toBeUndefined();

    await act(async () => {
      found.resolve([]);
      await found.promise;
    });
    await waitFor(() => expect(result.current.pending).toBe(false));
  });

  test("a key with no runs leaves an ordinary empty form", async () => {
    const api = fakeApi({ find: vi.fn(async () => []) });
    const { result } = renderSubmit(api, { key: KEY, recover: true });

    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.run).toBeUndefined();
    expect(result.current.error).toBeUndefined();
  });

  test("does not overwrite a run started before the lookup landed", async () => {
    const found = Promise.withResolvers<WorkflowRun[]>();
    const api = fakeApi({
      find: vi.fn(() => found.promise),
      get: vi.fn(async (runId: string) => run({ runId, status: "running" })),
    });
    const { result } = renderSubmit(api, { key: KEY, recover: true });

    await act(() => result.current.submit({ url: "u" }));
    await waitFor(() => expect(result.current.run?.runId).toBe("wrun_1"));

    // A slow lookup answering with an OLDER run of the same key must not
    // replace the one the person just started — the newest run is the one they
    // are looking at, and it is not the one this answer names.
    await act(async () => {
      found.resolve([run({ runId: "wrun_old" })]);
      await found.promise;
    });
    expect(result.current.run?.runId).toBe("wrun_1");
  });

  test("reports a failed lookup rather than showing a form with no run", async () => {
    // Swallowing it is the worse half of the trade: a person with a live run
    // sees an empty form and starts a second one, which is the duplicated work
    // the key exists to prevent. A page that has never run anything pays a
    // banner it can ignore.
    const api = fakeApi({
      find: vi.fn(async () => {
        throw new Error("agent unavailable");
      }),
    });
    const { result } = renderSubmit(api, { key: KEY, recover: true });

    await waitFor(() => expect(result.current.error).toBe("agent unavailable"));
    expect(result.current.pending).toBe(false);
  });

  test("reset() is not undone by a second lookup", async () => {
    const api = fakeApi({
      find: vi.fn(async () => [run({ runId: "wrun_9", status: "running" })]),
    });
    const { result } = renderSubmit(api, { key: KEY, recover: true });
    await waitFor(() => expect(result.current.run?.runId).toBe("wrun_9"));

    act(() => {
      result.current.reset();
    });

    // The recovery is a MOUNT-time act. Re-running it whenever the hook holds
    // no run would re-adopt the run the person had just dismissed, which is a
    // Clear button that clears nothing.
    await waitFor(() => expect(result.current.run).toBeUndefined());
    expect(api.find).toHaveBeenCalledTimes(1);
  });
});
