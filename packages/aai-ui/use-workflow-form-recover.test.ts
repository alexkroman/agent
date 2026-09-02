// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/**
 * Finding the run again after a RELOAD — `useWorkflowSubmit({ key, recover })`.
 *
 * A reload is reproducible here exactly: unmount the hook and render it again.
 * Nothing else about the page changes — same agent, same client, same workflow —
 * and that is the whole of what a refresh does to this hook, because the run id
 * it holds is plain `useState`.
 *
 * The first spec is the defect, kept as the control: with no key there is
 * nothing to look a run up BY, so a remount is entitled to come back empty and
 * the assertions say so. Every spec after it is about the key, and what they
 * pin is the four decisions the lookup makes rather than the request itself —
 * `find` is `workflow-client.test.ts`'s subject, and the watch that follows the
 * adopted id is `use-workflow-run.test.ts`'s.
 *
 * Its own file rather than more of `use-workflow-form.test.ts`, on that file's
 * own precedent (`use-workflow-form-recall.test.ts`, the upload half of the
 * same reload): one subject per file, and that one is near the test-length cap.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createMockWorkflowApi, refuseNetwork, workflowRun as run } from "./_react-test-utils.ts";
import type { TestWorkflow } from "./_workflow-test-defs.ts";
import { useWorkflowSubmit } from "./use-workflow-form.ts";
import type { WorkflowApi, WorkflowRun } from "./workflow-client.ts";

/** Short enough that the poll's first re-read is never what a spec waits on. */
const POLL_MS = 5;

/**
 * The key a page would have minted for itself.
 *
 * Opaque on purpose, which is the template's decision restated as a fixture: a
 * key derived from the submitted input would collide between two people
 * digesting one link, and would carry what they read.
 */
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
  vi.useRealTimers();
});

describe("useWorkflowSubmit — the run after a reload", () => {
  test("with no key, a remount cannot find the run — and asks nobody", async () => {
    const api = fakeApi();
    const first = renderSubmit(api);
    await act(() => first.result.current.submit({ url: "u" }));
    await waitFor(() => expect(first.result.current.run?.runId).toBe("wrun_1"));

    // The reload. The run is still going on the agent; the id was in this
    // component's state and the state is gone with it.
    first.unmount();
    const second = renderSubmit(api);

    await waitFor(() => expect(second.result.current.pending).toBe(false));
    expect(second.result.current.run).toBeUndefined();
    // The point of the control: there is no lookup to make without a key, so
    // the page is not merely unlucky — it holds nothing to ask with.
    expect(api.find).not.toHaveBeenCalled();
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

  test("a key without `recover` records the run and looks up nothing", async () => {
    const api = fakeApi({ find: vi.fn(async () => [run({ runId: "wrun_9" })]) });
    const { result } = renderSubmit(api, { key: KEY });

    await act(() => result.current.submit({ url: "u" }));

    // The key still reaches `start`, which is what makes the run findable at
    // all — by this page on its next load, or by anything else holding the key.
    expect(api.start).toHaveBeenCalledWith("digest", { url: "u" }, { key: KEY });
    expect(api.find).not.toHaveBeenCalled();
  });
});
