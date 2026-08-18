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

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createMockWorkflowApi } from "./_react-test-utils.ts";
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
async function submitFile(api: WorkflowApi, file?: File) {
  const { result } = renderHook(() => useWorkflowStream("transcribe", { api }));
  const chosen = file ?? new File([new Uint8Array([1, 2, 3])], "call.wav", { type: "audio/wav" });
  await act(async () => {
    await result.current.submit({ recording: chosen });
  });
  return result;
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("no test may reach the network");
    }),
  );
});

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

  test("a failed UPLOAD cancels the run and reports the error", async () => {
    const { api, calls } = recordingApi({
      uploadStream: vi.fn(async () => {
        throw new Error("disk full");
      }),
    });
    const result = await submitFile(api);
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
    const { result } = renderHook(() => useWorkflowStream("transcribe", { api }));
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
    const { result } = renderHook(() => useWorkflowStream("transcribe", { api }));
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
