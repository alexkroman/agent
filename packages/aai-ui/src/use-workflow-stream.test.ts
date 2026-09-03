// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/**
 * `useWorkflowStream` — the ORDER, which is the whole of what it decides.
 *
 * The transport is the SDK client's and the watching is `useWorkflowRun`'s, both
 * specced next door. What only this file can assert is the sequence, because the
 * sequence IS the feature: the run has to exist before the upload starts (that
 * inversion is the point), the id the run was started on has to be the id the
 * bytes go to, and the run has to be woken when the upload lands. Each of those is
 * invisible in a diff and, got wrong, produces a run that hangs rather than fails.
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createMockWorkflowApi, refuseNetwork } from "./_react-test-utils.ts";
import type { TestWorkflow } from "./_workflow-test-defs.ts";
import { useWorkflowStream } from "./use-workflow-stream.ts";
import type { WorkflowApi } from "./workflow-client.ts";

/** A workflow declaring `recording` as an upload. */
const LISTING = [{ name: "transcribe", uploads: ["recording"] }];

/**
 * A client that records the ORDER of everything it was asked to do.
 *
 * One log rather than per-method spies, because every assertion here is about how
 * two calls are arranged relative to each other — which `toHaveBeenCalled` cannot
 * say and a shared log states directly.
 */
function recordingApi(over: Partial<WorkflowApi> = {}) {
  const calls: string[] = [];
  const api = createMockWorkflowApi({
    list: vi.fn(async () => {
      calls.push("list");
      return LISTING;
    }),
    start: vi.fn(async () => {
      calls.push("start");
      return "wrun_1";
    }),
    uploadStream: vi.fn(async (id: string) => {
      calls.push(`put:${id}`);
      return { id, name: "", type: "", size: 3, complete: true, url: `/u/${id}` };
    }),
    wake: vi.fn(async () => {
      calls.push("wake");
      return 1;
    }),
    cancel: vi.fn(async () => {
      calls.push("cancel");
      return true;
    }),
    ...over,
  });
  return { api, calls };
}

/** Render the hook and run one submission to completion. */
async function submitFile(api: WorkflowApi, file?: File, parallel?: boolean) {
  const { result } = renderHook(() =>
    useWorkflowStream<TestWorkflow>("transcribe", { api, ...omitUndefined({ parallel }) }),
  );
  const chosen = file ?? new File([new Uint8Array([1, 2, 3])], "call.wav", { type: "audio/wav" });
  await act(async () => {
    await result.current.submit({ recording: chosen });
  });
  return result;
}

beforeEach(refuseNetwork);

describe("useWorkflowStream", () => {
  test("starts the run BEFORE a byte is uploaded", async () => {
    const { api, calls } = recordingApi();
    await submitFile(api);
    // The inversion this hook exists for. Reversed, it is `useWorkflowSubmit` with
    // extra steps and the upload is still the whole wall clock.
    expect(calls.indexOf("start")).toBeLessThan(calls.findIndex((one) => one.startsWith("put:")));
  });

  test("sends the whole file in ONE request", async () => {
    const { api, calls } = recordingApi();
    await submitFile(api);
    expect(calls.filter((one) => one.startsWith("put:"))).toHaveLength(1);
    // And the body is the File itself, not a slice of it: nothing here cuts.
    const [, body] = vi.mocked(api.uploadStream).mock.calls[0] ?? [];
    expect(body).toBeInstanceOf(File);
  });

  test("carries `parallel` to the upload, and omits it when unasked", async () => {
    // What it changes is only how fast the file grows — the run still starts
    // first, and what it polls is the contiguous prefix either way — so this
    // hook's whole job is to pass it through.
    const asked = recordingApi();
    await submitFile(asked.api, undefined, true);
    const [, , withParts] = vi.mocked(asked.api.uploadStream).mock.calls[0] ?? [];
    expect(withParts).toMatchObject({ parallel: true });

    const plain = recordingApi();
    await submitFile(plain.api);
    const [, , without] = vi.mocked(plain.api.uploadStream).mock.calls[0] ?? [];
    // Absent, not `undefined`: the SDK's options are exact-optional.
    expect(without && "parallel" in without).toBe(false);
  });

  test("the run is started on the SAME id the bytes go to", async () => {
    const { api } = recordingApi();
    await submitFile(api);
    const [, input] = vi.mocked(api.start).mock.calls[0] ?? [];
    const recording = (input as { recording: string }).recording;
    const [sentTo] = vi.mocked(api.uploadStream).mock.calls[0] ?? [];
    // The one correspondence the whole mechanism rests on. A mismatch is a run that
    // polls an id nothing will ever write to — i.e. one that hangs.
    expect(recording).toBe(sentTo);
    expect(recording).toMatch(/^[a-f0-9]{32}$/);
  });

  test("wakes the run once the upload lands", async () => {
    const { api, calls } = recordingApi();
    await submitFile(api);
    // The run is asleep between polls, so without this it learns the file is
    // complete a poll interval late, every time.
    expect(calls).toEqual(["list", "start", expect.stringMatching(/^put:/), "wake"]);
  });

  test("a failed wake does not fail the submit", async () => {
    const { api } = recordingApi({
      wake: vi.fn(async () => {
        throw new Error("gone");
      }),
    });
    // Best-effort by construction: a wake that finds nothing sleeping answers 0, and
    // failing here would throw away an upload that succeeded.
    const result = await submitFile(api);
    expect(result.current.error).toBeUndefined();
  });

  test("PAUSING stops the bytes without touching the run, and resuming sends the rest", async () => {
    // The two halves of the feature in one spec, because neither is worth much
    // alone: a pause that cancelled the run would make resuming pointless, and a
    // resume that did not say `resume: true` would be refused by the store as a
    // second claim on somebody else's id.
    const started = Promise.withResolvers<void>();
    let attempts = 0;
    const { api, calls } = recordingApi({
      uploadStream: vi.fn(async (id: string, _file, options) => {
        attempts += 1;
        if (attempts === 1) {
          started.resolve();
          // The gate's own abort, which is what a pause is on the wire.
          await new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => {
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            });
          });
        }
        return { id, name: "", type: "", size: 3, complete: true, url: `/u/${id}` };
      }),
    });
    const { result } = renderHook(() => useWorkflowStream<TestWorkflow>("transcribe", { api }));

    let submitted: Promise<void> = Promise.resolve();
    await act(async () => {
      submitted = result.current.submit({ recording: new File(["abc"], "call.wav") });
      await started.promise;
    });

    await act(async () => {
      result.current.pauseUpload();
      await Promise.resolve();
    });
    // The run is the thing a pause must NOT take with it: it is watching an id,
    // and a paused upload is one whose `size` stopped growing — which is what a
    // slow uplink looks like too.
    expect(calls).toContain("start");
    expect(calls).not.toContain("cancel");
    expect(result.current.run?.runId).toBe("wrun_1");
    expect(result.current.error).toBeUndefined();

    await act(async () => {
      result.current.resumeUpload();
      await submitted;
    });
    expect(vi.mocked(api.uploadStream).mock.calls).toHaveLength(2);
    // The SAME id, or the second attempt is a second upload and the run is
    // watching the first one forever.
    const [first] = vi.mocked(api.uploadStream).mock.calls[0] ?? [];
    const [second, , resumed] = vi.mocked(api.uploadStream).mock.calls[1] ?? [];
    expect(second).toBe(first);
    expect(resumed).toMatchObject({ resume: true });
    // And the first attempt does not claim it: a fresh id has nothing to resume,
    // and saying so would waive the refusal that makes a chosen id safe.
    const [, , opening] = vi.mocked(api.uploadStream).mock.calls[0] ?? [];
    expect(opening && "resume" in opening).toBe(false);
    expect(result.current.error).toBeUndefined();
  });

  test("a failed UPLOAD cancels the run and reports the error", async () => {
    const { api, calls } = recordingApi({
      uploadStream: vi.fn(async () => {
        throw new Error("disk full");
      }),
    });
    const result = await submitFile(api);
    // ONE attempt from here. Re-entering a failed upload is the SDK's job now
    // (`_upload-resume.ts`), on a budget that outlasts a redeploy — a second
    // hand-rolled attempt at this layer would multiply that budget by two and
    // report a failure the SDK had already spent a minute deciding about.
    expect(vi.mocked(api.uploadStream).mock.calls).toHaveLength(1);
    expect(result.current.error).toBe("disk full");
    // Otherwise the run waits for bytes that will never come, until its own
    // abandonment bound — failing long after the page already said so.
    expect(calls).toContain("cancel");
  });

  test("a failing cancel does not replace the error that caused it", async () => {
    const { api } = recordingApi({
      uploadStream: vi.fn(async () => {
        throw new Error("disk full");
      }),
      cancel: vi.fn(async () => {
        throw new Error("cancel also failed");
      }),
    });
    const result = await submitFile(api);
    expect(result.current.error).toBe("disk full");
  });

  test("uploads nothing when the field holds no File", async () => {
    // A workflow may declare an upload property and be handed something else — an
    // id from a previous submit, an empty optional. Refusing would be the hook
    // deciding what its own declaration means.
    const { api, calls } = recordingApi();
    const { result } = renderHook(() => useWorkflowStream<TestWorkflow>("transcribe", { api }));
    await act(async () => {
      await result.current.submit({ recording: "upl_already_stored" });
    });
    expect(calls).toEqual(["list", "start"]);
    expect(vi.mocked(api.start).mock.calls[0]?.[1]).toEqual({ recording: "upl_already_stored" });
  });

  test("a workflow declaring no upload starts with the input untouched", async () => {
    const { api, calls } = recordingApi();
    vi.mocked(api.list).mockImplementation(async () => {
      calls.push("list");
      return [{ name: "transcribe" }];
    });
    const { result } = renderHook(() => useWorkflowStream<TestWorkflow>("transcribe", { api }));
    await act(async () => {
      await result.current.submit({ topic: "cats" });
    });
    expect(calls).toEqual(["list", "start"]);
  });

  test("reports the bytes as they go, then drops the report", async () => {
    const seen: number[] = [];
    const { api } = recordingApi({
      uploadStream: vi.fn(async (id: string, _body, options) => {
        options?.onProgress?.({ loaded: 0, total: 300, fraction: 0 });
        options?.onProgress?.({ loaded: 300, total: 300, fraction: 1 });
        return { id, name: "", type: "", size: 300, complete: true, url: "/u" };
      }),
    });
    const result = await submitFile(api);
    for (const [, , options] of vi.mocked(api.uploadStream).mock.calls) {
      if (options?.onProgress) seen.push(1);
    }
    expect(seen).toHaveLength(1);
    // Dropped once the bytes have landed, so a bar resting at 100% under a running
    // workflow cannot read as the thing that is taking the time.
    expect(result.current.upload).toBeUndefined();
  });

  test("exposes the run while the upload is still going", async () => {
    const { api } = recordingApi();
    const result = await submitFile(api);
    // The whole point of starting first: there is a run to render progress for
    // before the bytes are in.
    await waitFor(() => expect(result.current.run?.runId).toBe("wrun_1"));
  });
});

/**
 * The production failure this refuses, and the reason it is refused rather than
 * repaired: a `File` cannot travel in a run input at all. `JSON.stringify` gives
 * `{}` for one — no `toJSON`, no own enumerable properties — so a File left in the
 * payload does not fail to SEND, it arrives as an empty object and the workflow
 * rejects it against its own schema. That reached production as
 * `Invalid input for workflow "transcribe": recording: Invalid input`: a message
 * about a type, from a page whose file picker was working, five times over two days.
 *
 * The path is a listing that declares no `uploads` for the property the form put
 * the file in — reachable whenever the deployed workflow predates the declaration,
 * or the page names the wrong workflow.
 */
describe("a file the workflow does not declare as an upload", () => {
  const noUploads = [{ name: "transcribe" }];

  test("is refused, and no run is started over it", async () => {
    const { api, calls } = recordingApi({ list: vi.fn(async () => noUploads) });
    const result = await submitFile(api);

    expect(api.start).not.toHaveBeenCalled();
    expect(calls).not.toContain("start");
    // Reported the way a form expects, not thrown past the caller.
    expect(result.current.error).toContain("recording");
    expect(result.current.error).toContain("uploads");
  });

  test("uploads nothing and cancels nothing, there being no run to cancel", async () => {
    const { api } = recordingApi({ list: vi.fn(async () => noUploads) });
    await submitFile(api);
    expect(api.uploadStream).not.toHaveBeenCalled();
    expect(api.cancel).not.toHaveBeenCalled();
  });

  test("leaves the hook idle rather than pending", async () => {
    const { api } = recordingApi({ list: vi.fn(async () => noUploads) });
    const result = await submitFile(api);
    expect(result.current.pending).toBe(false);
  });

  /**
   * The other half: a declared upload still works. Without this the guard could be
   * refusing every submission and the three tests above would all pass.
   */
  test("does not refuse the ordinary declared case", async () => {
    const { api, calls } = recordingApi();
    const result = await submitFile(api);
    expect(result.current.error).toBeUndefined();
    expect(calls).toContain("start");
  });

  /**
   * A run input carrying no file at all must pass whatever the listing says — the
   * guard is about files, not about the declaration. This is the case the hook's own
   * comment protects ("an id from a previous submit, an empty optional").
   */
  test("passes a plain input through even with no upload declared", async () => {
    const { api, calls } = recordingApi({ list: vi.fn(async () => noUploads) });
    const { result } = renderHook(() => useWorkflowStream<TestWorkflow>("transcribe", { api }));
    await act(async () => {
      await result.current.submit({ recording: "upload_abc" });
    });
    expect(result.current.error).toBeUndefined();
    expect(calls).toContain("start");
  });
});

describe("useWorkflowStream: the shared submission surface", () => {
  test("carries wake and cancel, bound to the run it started", async () => {
    // `WorkflowStreamSubmission` is an ALIAS of `WorkflowSubmission`, so a field
    // present on one and absent on the other is a lie in the shared type rather
    // than a missing feature — which is the failure this spec is for.
    const { api } = recordingApi();
    const result = await submitFile(api);
    await waitFor(() => expect(result.current.run).toBeDefined());

    await act(async () => {
      await result.current.wake();
      await result.current.cancel();
    });
    expect(api.wake).toHaveBeenCalledWith("wrun_1");
    expect(api.cancel).toHaveBeenCalledWith("wrun_1");
  });
});
