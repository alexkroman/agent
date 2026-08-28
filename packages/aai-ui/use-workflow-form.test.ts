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
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createMockWorkflowApi, refuseNetwork, workflowRun as run } from "./_react-test-utils.ts";
import type { TestWorkflow } from "./_workflow-test-defs.ts";
import { useWorkflowSubmit, useWorkflows } from "./use-workflow-form.ts";
import { MAX_MISSING_READS } from "./use-workflow-run.ts";
import type { WorkflowApi, WorkflowRun } from "./workflow-client.ts";

/**
 * Poll interval for the specs that watch a run settle.
 *
 * Most specs here never reach the SECOND read — `repeatUntil` fires its first
 * step immediately — so they assert React state transitions through `waitFor`
 * on real time, and shrinking the interval only keeps the default 2s out of
 * their budgets. The interval is not what those specs are about.
 *
 * The give-up spec IS about it: it has to wait out `MAX_MISSING_READS` of
 * them, and the root guide's rule is that a spec observing a timer runs on
 * virtual time, never the wall clock — a spec that waits out real milliseconds
 * to see whether a window elapsed is a race, and the flake then names the
 * timing spec rather than the bug. It installs fake timers of its own and uses
 * `act` + `advanceTimersByTimeAsync`, the sibling's pattern in
 * `use-workflow-run.test.ts`, which sidesteps the `waitFor`-versus-fake-timers
 * conflict this comment used to give as the reason for real time everywhere.
 */
const POLL_MS = 5;

/**
 * A client whose `watch` always declines, so the hook under test falls through
 * to `useWorkflowRun`'s poll — the path a test can drive.
 *
 * The shared builder's defaults already decline; this only names the two reads
 * these specs assert on.
 */
function fakeApi(over: Partial<WorkflowApi> = {}): WorkflowApi {
  return createMockWorkflowApi({
    upload: vi.fn(async () => ({
      id: "upl_1",
      name: "",
      type: "",
      size: 0,
      complete: true,
      url: "/uploads/upl_1",
    })),
    list: vi.fn(async () => [{ name: "digest" }]),
    startAndWait: vi.fn(async () => run({ status: "completed" })),
    get: vi.fn(async () => run({ status: "completed" })),
    ...over,
  });
}

beforeEach(refuseNetwork);

afterEach(() => {
  // `useFakeTimers` is outside `restoreMocks`; one spec below installs them.
  vi.useRealTimers();
  // So is `sessionStorage`, and an upload id lives there for the life of the tab
  // (`_upload-recall.ts`) — which across specs means one spec's stored file
  // deciding the next spec's upload, in file order.
  sessionStorage.clear();
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
    const { result } = renderHook(() =>
      useWorkflowSubmit<TestWorkflow>("digest", { api, intervalMs: POLL_MS }),
    );

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
    const { result } = renderHook(() =>
      useWorkflowSubmit<TestWorkflow>("digest", { api, intervalMs: POLL_MS }),
    );

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
    const { result } = renderHook(() =>
      useWorkflowSubmit<TestWorkflow>("digest", { api, intervalMs: POLL_MS }),
    );

    await act(() => result.current.submit({ recording: file, languageCode: "en" }));

    // `uploadStream`, not `upload`, and the id is the reason: this hook mints it
    // so an interrupted upload has a name to be picked up again under — see
    // `uploadFiles`. Which id it is remains this hook's business, so the spec
    // asserts the two ends AGREE rather than pinning a value.
    expect(api.uploadStream).toHaveBeenCalledWith(expect.any(String), file, {
      name: "standup.wav",
      signal: expect.any(AbortSignal),
      onProgress: expect.any(Function),
    });
    const [id] = vi.mocked(api.uploadStream).mock.calls[0] ?? [];
    expect(api.start).toHaveBeenCalledWith("digest", { recording: id, languageCode: "en" }, {});
  });

  test("passes `parallel` down to the upload, and omits it when unasked", async () => {
    // The option describes the UPLOAD, so this hook's only job is to carry it —
    // and to carry it as ABSENT when nobody asked, since a `parallel: undefined`
    // in the options object is a different thing to the SDK's exact-optional
    // signature than no key at all.
    const asked = fakeApi();
    const file = new File(["abc"], "standup.wav", { type: "audio/wav" });
    const withParts = renderHook(() =>
      useWorkflowSubmit<TestWorkflow>("digest", {
        api: asked,
        intervalMs: POLL_MS,
        parallel: true,
      }),
    );
    await act(() => withParts.result.current.submit({ recording: file }));
    expect(asked.uploadStream).toHaveBeenCalledWith(expect.any(String), file, {
      name: "standup.wav",
      signal: expect.any(AbortSignal),
      onProgress: expect.any(Function),
      parallel: true,
    });

    const plain = fakeApi();
    // Its OWN file, because the one above is now stored: an id survives the tab
    // (`_upload-recall.ts`), so re-submitting the same file reuses the upload
    // instead of sending it again — which is the point of that mechanism and
    // would leave this spec with no second upload to read the options off.
    const other = new File(["abc"], "planning.wav", { type: "audio/wav" });
    const without = renderHook(() =>
      useWorkflowSubmit<TestWorkflow>("digest", { api: plain, intervalMs: POLL_MS }),
    );
    await act(() => without.result.current.submit({ recording: other }));
    expect(plain.uploadStream).toHaveBeenCalledWith(expect.any(String), other, {
      name: "planning.wav",
      signal: expect.any(AbortSignal),
      onProgress: expect.any(Function),
    });
  });

  test("reports the bytes as they go, then drops the report once the run starts", async () => {
    // Two files, each held open, so what a bar would draw is observed at each
    // step rather than inferred from whatever React last committed.
    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    let call = 0;
    const api = fakeApi({
      uploadStream: vi.fn(async (id, _file, options) => {
        const gate = gates[call++];
        options?.onProgress?.({ loaded: 0, total: 400, fraction: 0 });
        options?.onProgress?.({ loaded: 200, total: 400, fraction: 0.5 });
        await gate?.promise;
        return { id, name: "", type: "", size: 400, complete: true, url: "/uploads" };
      }),
    });
    const files = [new File(["a"], "one.wav"), new File(["b"], "two.wav")];
    const { result } = renderHook(() =>
      useWorkflowSubmit<TestWorkflow>("digest", { api, intervalMs: POLL_MS }),
    );
    expect(result.current.upload).toBeUndefined();

    let submitted: Promise<void> = Promise.resolve();
    await act(async () => {
      submitted = result.current.submit({ recordings: files });
      await Promise.resolve();
    });

    // `count` is 2 on the FIRST report: every file is counted before the first
    // byte leaves, so a bar never says "1 of 1" and then changes its mind.
    expect(result.current.upload).toEqual({
      name: "one.wav",
      index: 1,
      count: 2,
      loaded: 200,
      total: 400,
      fraction: 0.5,
      paused: false,
    });

    gates[0]?.resolve();
    await waitFor(() =>
      expect(result.current.upload).toMatchObject({ name: "two.wav", index: 2, count: 2 }),
    );

    gates[1]?.resolve();
    await act(async () => {
      await submitted;
    });
    // The bytes are gone, so the bar goes: from here the wait is the RUN's, and
    // one left at 100% under a running workflow reads as the slow part.
    expect(result.current.upload).toBeUndefined();
    const ids = vi.mocked(api.uploadStream).mock.calls.map(([id]) => id);
    expect(api.start).toHaveBeenCalledWith("digest", { recordings: ids }, {});
  });

  test("drops the report when the upload FAILS, so no bar sits under the error", async () => {
    const api = fakeApi({
      uploadStream: vi.fn(async (_id, _file, options) => {
        options?.onProgress?.({ loaded: 8, total: 64, fraction: 0.125 });
        throw new Error("upload exceeds 268435456 bytes");
      }),
    });
    const { result } = renderHook(() =>
      useWorkflowSubmit<TestWorkflow>("digest", { api, intervalMs: POLL_MS }),
    );

    await act(() => result.current.submit({ recording: new File(["a"], "big.wav") }));

    await waitFor(() => expect(result.current.error).toMatch(/268435456/));
    expect(result.current.upload).toBeUndefined();
  });

  test("PAUSING parks the upload and resuming sends only what is left", async () => {
    // Two files, so the spec also covers the part a single file cannot show: a
    // resumed walk re-enters `uploadFiles` from the top and must not re-send the
    // recording that already landed.
    const started = Promise.withResolvers<void>();
    const attempts: string[] = [];
    const api = fakeApi({
      uploadStream: vi.fn(async (id, file, options) => {
        const name = file instanceof File ? file.name : "?";
        attempts.push(name);
        options?.onProgress?.({ loaded: 40, total: 100, fraction: 0.4 });
        if (name === "two.wav" && attempts.filter((one) => one === "two.wav").length === 1) {
          started.resolve();
          await new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => {
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            });
          });
        }
        return { id, name, type: "", size: 100, complete: true, url: `/u/${id}` };
      }),
    });
    const files = [new File(["a"], "one.wav"), new File(["b"], "two.wav")];
    const { result } = renderHook(() =>
      useWorkflowSubmit<TestWorkflow>("digest", { api, intervalMs: POLL_MS }),
    );

    let submitted: Promise<void> = Promise.resolve();
    await act(async () => {
      submitted = result.current.submit({ recordings: files });
      await started.promise;
    });

    await act(async () => {
      result.current.pauseUpload();
      await Promise.resolve();
    });
    // The bar keeps its bytes and says what it is doing — a paused upload and a
    // stalled one are the same picture without this flag.
    expect(result.current.upload).toMatchObject({ name: "two.wav", loaded: 40, paused: true });
    expect(api.start).not.toHaveBeenCalled();

    await act(async () => {
      result.current.resumeUpload();
      await submitted;
    });
    // `one.wav` is stored, so the resumed walk skips it: three attempts total, and
    // the third is the second file again rather than the first.
    expect(attempts).toEqual(["one.wav", "two.wav", "two.wav"]);
    const [, , resumed] = vi.mocked(api.uploadStream).mock.calls[2] ?? [];
    expect(resumed).toMatchObject({ resume: true });
    // The SAME id both times, or the run would be started on an upload holding
    // only the tail of the file.
    const ids = vi.mocked(api.uploadStream).mock.calls.map(([id]) => id);
    expect(ids[1]).toBe(ids[2]);
    expect(api.start).toHaveBeenCalledWith("digest", { recordings: [ids[0], ids[1]] }, {});
  });

  test("reset abandons an upload in flight rather than reporting it as failed", async () => {
    const started = Promise.withResolvers<void>();
    const api = fakeApi({
      uploadStream: vi.fn(async (_id, _file, options) => {
        started.resolve();
        await new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        });
        throw new Error("unreachable");
      }),
    });
    const { result } = renderHook(() =>
      useWorkflowSubmit<TestWorkflow>("digest", { api, intervalMs: POLL_MS }),
    );

    let submitted: Promise<void> = Promise.resolve();
    await act(async () => {
      submitted = result.current.submit({ recording: new File(["a"], "big.wav") });
      await started.promise;
    });

    await act(async () => {
      result.current.reset();
      await submitted;
    });
    // A form put back to its initial state has no submission to fail: an error
    // here would be the page reporting the person's own button back to them.
    expect(result.current.error).toBeUndefined();
    expect(result.current.upload).toBeUndefined();
    expect(api.start).not.toHaveBeenCalled();
  });

  test("leaves a MIXED array alone rather than storing half of it", async () => {
    // An array that is not files all the way through is some other field's
    // value that happens to contain one; turning half of it into ids would
    // corrupt it with nothing reporting so.
    const api = fakeApi();
    const mixed = [new File(["a"], "one.wav"), "two.wav"];
    const { result } = renderHook(() =>
      useWorkflowSubmit<TestWorkflow>("digest", { api, intervalMs: POLL_MS }),
    );

    await act(() => result.current.submit({ recordings: mixed }));

    expect(api.uploadStream).not.toHaveBeenCalled();
    expect(api.start).toHaveBeenCalledWith("digest", { recordings: mixed }, {});
  });

  test("stores every file of a multiple field, in order", async () => {
    const api = fakeApi();
    const files = [new File(["a"], "one.wav"), new File(["b"], "two.wav")];
    const { result } = renderHook(() =>
      useWorkflowSubmit<TestWorkflow>("digest", { api, intervalMs: POLL_MS }),
    );

    await act(() => result.current.submit({ recordings: files }));

    expect(api.uploadStream).toHaveBeenCalledTimes(2);
    const stored = vi.mocked(api.uploadStream).mock.calls.map(([id]) => id);
    // Two files, two ids: an id is per FILE, so a shared one would have the
    // second recording writing over the first.
    expect(new Set(stored).size).toBe(2);
    expect(api.start).toHaveBeenCalledWith("digest", { recordings: stored }, {});
  });

  test("leaves an input with no files exactly as it was", async () => {
    const api = fakeApi();
    const { result } = renderHook(() =>
      useWorkflowSubmit<TestWorkflow>("digest", { api, intervalMs: POLL_MS }),
    );

    await act(() => result.current.submit({ url: "u", count: 3, deep: true }));

    expect(api.uploadStream).not.toHaveBeenCalled();
    expect(api.start).toHaveBeenCalledWith("digest", { url: "u", count: 3, deep: true }, {});
  });

  test("reports a failed upload as the submit's error, without starting a run", async () => {
    const api = fakeApi({
      uploadStream: vi.fn(async () => {
        throw new Error("upload exceeds 268435456 bytes");
      }),
    });
    const { result } = renderHook(() =>
      useWorkflowSubmit<TestWorkflow>("digest", { api, intervalMs: POLL_MS }),
    );

    await act(() => result.current.submit({ recording: new File(["a"], "big.wav") }));

    expect(api.start).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.error).toMatch(/268435456/));
  });

  test("passes a correlation key through when one is given", async () => {
    const api = fakeApi();
    const { result } = renderHook(() =>
      useWorkflowSubmit<TestWorkflow>("digest", { api, key: "user-7", intervalMs: POLL_MS }),
    );
    await act(() => result.current.submit({}));
    expect(api.start).toHaveBeenCalledWith("digest", {}, { key: "user-7" });
  });

  test("uses the synchronous call when a wait is asked for, and follows the same id", async () => {
    const api = fakeApi({
      startAndWait: vi.fn(async () => run({ runId: "wrun_5", status: "completed" })),
    });
    const { result } = renderHook(() =>
      useWorkflowSubmit<TestWorkflow>("digest", { api, wait: 5000, intervalMs: POLL_MS }),
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
    const { result } = renderHook(() =>
      useWorkflowSubmit<TestWorkflow>("digest", { api, intervalMs: POLL_MS }),
    );

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
    const { result } = renderHook(() =>
      useWorkflowSubmit<TestWorkflow>("digest", { api, intervalMs: POLL_MS }),
    );

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
    vi.useFakeTimers();
    const api = fakeApi({ get: vi.fn(async () => undefined) });
    const { result } = renderHook(() =>
      useWorkflowSubmit<TestWorkflow>("digest", { api, intervalMs: POLL_MS }),
    );

    await act(async () => {
      await result.current.submit({});
    });
    // Every remaining read at once, on virtual time — see `POLL_MS`.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * MAX_MISSING_READS);
    });

    expect(result.current.error).toBe("No workflow run wrun_1");
    expect(api.get).toHaveBeenCalledTimes(MAX_MISSING_READS);
    expect(result.current.run).toBeUndefined();
    expect(result.current.pending).toBe(false);
  });

  test("reset puts the form back to its initial state", async () => {
    const api = fakeApi();
    const { result } = renderHook(() =>
      useWorkflowSubmit<TestWorkflow>("digest", { api, intervalMs: POLL_MS }),
    );

    await act(() => result.current.submit({}));
    await waitFor(() => expect(result.current.run).toBeDefined());

    act(() => result.current.reset());
    expect(result.current.run).toBeUndefined();
    expect(result.current.pending).toBe(false);
  });
});

describe("useWorkflowSubmit: wake and cancel", () => {
  test("wake and cancel target the run this submission is following", async () => {
    // The whole reason a page holding this hook needed an `api` of its own: the
    // hook knew the run id and would not hand it back, so `link-digest` and
    // `podcast-digest` each keep a module-scope client purely to write
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
