// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/**
 * Finding the run again after a RELOAD — what `useWorkflowSubmit` does on mount.
 *
 * A reload is reproducible here exactly: unmount the hook and render it again.
 * Nothing else about the page changes — same agent, same client, same workflow —
 * and that is the whole of what a refresh does to this hook, because the run id
 * it holds is plain `useState`.
 *
 * The first two specs are what this file exists for now that recovery is the
 * DEFAULT: a page that passes nothing at all still records its runs under a key
 * the next load produces again, and still gets the live one back. `recover:
 * false` is the control that used to be "no key" — it is the only way left to
 * reach the old behaviour, and its assertions are the ones the defect had.
 * Everything after that is the four decisions the lookup makes rather than the
 * request itself — `find` is `workflow-client.test.ts`'s subject, and the watch
 * that follows the adopted id is `use-workflow-run.test.ts`'s.
 *
 * Its own file rather than more of `use-workflow-form.test.ts`, on that file's
 * own precedent (`use-workflow-form-recall.test.ts`, the upload half of the
 * same reload): one subject per file, and that one is near the test-length cap.
 *
 * Every spec clears `sessionStorage` after it, because the default key LIVES
 * there for the life of the tab: one spec's key would otherwise be the next
 * one's, which is the same cross-spec leak the upload recall specs clear for.
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
  // The default key lives here for the life of the tab — see the module doc.
  sessionStorage.clear();
});

describe("useWorkflowSubmit — the run after a reload", () => {
  test("a page that passes nothing records its runs under a key it keeps", async () => {
    const api = fakeApi();
    const first = renderSubmit(api);
    await act(() => first.result.current.submit({ url: "u" }));

    const started = vi.mocked(api.start).mock.calls[0]?.[2];
    const key = started?.key;
    // The whole default: an opaque key, minted here, recorded with the run.
    expect(key).toEqual(expect.any(String));

    // The reload. The run id was this component's state and is gone with it —
    // the key is not, because it is in storage rather than in React.
    first.unmount();
    const second = renderSubmit(api);
    await waitFor(() => expect(second.result.current.pending).toBe(false));
    expect(api.find).toHaveBeenLastCalledWith("digest", key, { limit: 1 });
  });

  test("gets the live run back on the next load, with no options at all", async () => {
    const api = fakeApi({
      find: vi.fn(async () => [run({ runId: "wrun_9", status: "running" })]),
    });
    const { result } = renderSubmit(api);

    // Nothing was passed: no key, no `recover`. This is the reload a person
    // actually performs, and what they get back is the run they left.
    await waitFor(() => expect(result.current.run?.runId).toBe("wrun_9"));
  });

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

  test("a caller's key displaces the minted one, and nothing is stored for it", async () => {
    const api = fakeApi({ find: vi.fn(async () => []) });
    const { result } = renderSubmit(api, { key: KEY });

    await act(() => result.current.submit({ url: "u" }));

    // The page named the scope — an account id is the case this is for — so
    // both halves use it, and the hook mints nothing into storage that only it
    // would ever read.
    expect(api.start).toHaveBeenCalledWith("digest", { url: "u" }, { key: KEY });
    expect(api.find).toHaveBeenCalledWith("digest", KEY, { limit: 1 });
    expect(sessionStorage.length).toBe(0);
  });
});

/**
 * `startedHere` — the field six templates kept by hand as a `useState(false)`.
 *
 * The claim is that `run` alone cannot answer "did THIS load start it": these
 * specs put the hook in both states with the same resulting run and assert the
 * flag tells them apart, plus the third state (`!startedHere` and no run yet)
 * that is the reason the RAW fact is published rather than a derived
 * "recovered".
 */
describe("useWorkflowSubmit — startedHere", () => {
  test("true for a run this page started", async () => {
    const api = fakeApi();
    const { result } = renderSubmit(api);
    expect(result.current.startedHere).toBe(false);

    await act(() => result.current.submit({ url: "u" }));
    await waitFor(() => expect(result.current.run).toBeDefined());
    expect(result.current.startedHere).toBe(true);
  });

  test("false for a run adopted on the next load", async () => {
    const api = fakeApi({
      find: vi.fn(async () => [run({ runId: "wrun_9", status: "running" })]),
    });
    const { result } = renderSubmit(api);

    await waitFor(() => expect(result.current.run?.runId).toBe("wrun_9"));
    // Same shape of `run` as the spec above, opposite answer — which is the
    // whole reason a page cannot derive this from what it can see.
    expect(result.current.startedHere).toBe(false);
  });

  test("the THIRD state: still looking, and nothing was submitted", async () => {
    // `!startedHere` with no run yet. A page says "Looking for a run this tab
    // started earlier…" here, and a boolean meaning only "adopted" could not
    // tell this from the gap between a submit and its run existing.
    let release: (runs: WorkflowRun[]) => void = () => undefined;
    const api = fakeApi({
      find: vi.fn(
        () =>
          new Promise<WorkflowRun[]>((resolve) => {
            release = resolve;
          }),
      ),
    });
    const { result } = renderSubmit(api);

    expect(result.current.startedHere).toBe(false);
    expect(result.current.run).toBeUndefined();
    // And `pending` is true throughout, so the page is not offering Submit.
    expect(result.current.pending).toBe(true);
    await act(async () => {
      release([]);
    });
  });

  test("reset() clears it, without the page mirroring it", async () => {
    // The half every one of the six had to remember by hand in `onClear`.
    const api = fakeApi();
    const { result } = renderSubmit(api);
    await act(() => result.current.submit({ url: "u" }));
    await waitFor(() => expect(result.current.startedHere).toBe(true));

    act(() => {
      result.current.reset();
    });
    await waitFor(() => expect(result.current.run).toBeUndefined());
    expect(result.current.startedHere).toBe(false);
  });

  test("a submit after adopting one flips it", async () => {
    // A page offering Submit again after picking up an old run: the new run is
    // this page's, and the sentence has to change with it.
    const api = fakeApi({
      find: vi.fn(async () => [run({ runId: "wrun_9", status: "completed" })]),
    });
    const { result } = renderSubmit(api);
    await waitFor(() => expect(result.current.run?.runId).toBe("wrun_9"));
    expect(result.current.startedHere).toBe(false);

    await act(() => result.current.submit({ url: "u" }));
    await waitFor(() => expect(result.current.startedHere).toBe(true));
  });
});
