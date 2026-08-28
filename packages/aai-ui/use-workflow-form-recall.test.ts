// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/**
 * `useWorkflowSubmit` against an upload id a PREVIOUS page load minted.
 *
 * Its own file rather than more of `use-workflow-form.test.ts`, which is within
 * 10% of the test cap: what is asserted here is one mechanism end to end — the
 * recall (`_upload-recall.ts`), the `uploadInfo` check that decides whether to
 * trust it (`claimId` in `_upload-files.ts`), and what the hook does with each
 * of the three answers. The store's own round-tripping is specced next door in
 * `_upload-recall.test.ts`.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createMockWorkflowApi, refuseNetwork, workflowRun as run } from "./_react-test-utils.ts";
import { recallUploadId, rememberUploadId } from "./_upload-recall.ts";
import type { TestWorkflow } from "./_workflow-test-defs.ts";
import { useWorkflowSubmit } from "./use-workflow-form.ts";
import type { WorkflowApi } from "./workflow-client.ts";

/** Short enough that the watch's first read lands inside a spec's budget. */
const POLL_MS = 5;

/** The sibling suite's client: `watch` declines, the two reads answer completed. */
function fakeApi(over: Partial<WorkflowApi> = {}): WorkflowApi {
  return createMockWorkflowApi({
    list: vi.fn(async () => [{ name: "digest" }]),
    get: vi.fn(async () => run({ status: "completed" })),
    ...over,
  });
}

beforeEach(refuseNetwork);

afterEach(() => {
  // An upload id lives in `sessionStorage` for the life of the tab, so without
  // this one spec's stored file decides the next spec's upload, in file order.
  sessionStorage.clear();
});

describe("a reload resumes the upload rather than restarting it", () => {
  /**
   * A file with a FIXED identity, twice.
   *
   * A reload empties the input, so the person picks the file again and gets a
   * brand-new `File` — which is the case the recall has to survive, and the
   * reason it keys on the four fields rather than on the object.
   */
  const pick = () =>
    new File(["a".repeat(64)], "standup.wav", { type: "audio/wav", lastModified: 1 });

  test("sends only what is missing, under the id the previous load minted", async () => {
    const api = fakeApi({
      // What the agent says about the id the load that is gone was using: half
      // the recording landed, as windows.
      uploadInfo: vi.fn(async (id: string) => ({
        id,
        name: "standup.wav",
        type: "audio/wav",
        size: 32,
        complete: false,
        ranges: [{ start: 0, end: 32 }],
      })),
    });
    rememberUploadId("digest", pick(), "upl_from_the_last_load");
    const { result } = renderHook(() =>
      useWorkflowSubmit<TestWorkflow>("digest", { api, intervalMs: POLL_MS }),
    );

    await act(() => result.current.submit({ recording: pick() }));

    // The SAME id, and claimed as this load's own — without `resume` the parts
    // path reads its own 409 as somebody else holding the id.
    expect(api.uploadStream).toHaveBeenCalledWith(
      "upl_from_the_last_load",
      expect.any(File),
      expect.objectContaining({ resume: true }),
    );
    expect(api.start).toHaveBeenCalledWith("digest", { recording: "upl_from_the_last_load" }, {});
  });

  test("an upload that already finished is not sent again at all", async () => {
    // The refresh that costs one GET instead of a second 200 MB upload: the
    // bytes are all in, so the run starts on the id and nothing is uploaded.
    const api = fakeApi();
    rememberUploadId("digest", pick(), "upl_all_in");
    const { result } = renderHook(() =>
      useWorkflowSubmit<TestWorkflow>("digest", { api, intervalMs: POLL_MS }),
    );

    await act(() => result.current.submit({ recording: pick() }));

    expect(api.uploadStream).not.toHaveBeenCalled();
    expect(api.start).toHaveBeenCalledWith("digest", { recording: "upl_all_in" }, {});
  });

  test("a swept id is forgotten and the file gets a fresh one", async () => {
    // The agent no longer has it — an upload the sweep collected, or an agent
    // redeployed onto a fresh database. Reusing the id would send the file to
    // an upload nothing will read.
    const api = fakeApi({
      uploadInfo: vi.fn(async () => {
        throw new Error("no such upload");
      }),
    });
    rememberUploadId("digest", pick(), "upl_gone");
    const { result } = renderHook(() =>
      useWorkflowSubmit<TestWorkflow>("digest", { api, intervalMs: POLL_MS }),
    );

    await act(() => result.current.submit({ recording: pick() }));

    const [id, , options] = vi.mocked(api.uploadStream).mock.calls[0] ?? [];
    expect(id).not.toBe("upl_gone");
    // A fresh id has nothing to resume, and saying otherwise waives the refusal
    // that makes a caller-chosen id safe.
    expect(options).not.toMatchObject({ resume: true });
    // Dropped, so the next submission of this file does not pay for the same
    // 404 again for the life of the tab — and re-remembered under the new id.
    expect(recallUploadId("digest", pick())).toBe(id);
  });

  test("an unfinished upload with NO windows gets a fresh id", async () => {
    // A partial single `PUT` — which the store answers a second `PUT` to with a
    // 409 rather than an append, so reusing that id turns a reload into a
    // failure the person cannot clear.
    const api = fakeApi({
      uploadInfo: vi.fn(async (id: string) => ({
        id,
        name: "standup.wav",
        type: "audio/wav",
        size: 32,
        complete: false,
      })),
    });
    rememberUploadId("digest", pick(), "upl_partial_put");
    const { result } = renderHook(() =>
      useWorkflowSubmit<TestWorkflow>("digest", { api, intervalMs: POLL_MS }),
    );

    await act(() => result.current.submit({ recording: pick() }));

    const [id] = vi.mocked(api.uploadStream).mock.calls[0] ?? [];
    expect(id).not.toBe("upl_partial_put");
  });

  test("a file whose upload never started is remembered before its first byte", async () => {
    // The reload this exists for happens DURING the upload, so an id written
    // when the last byte lands is an id written for the one case that did not
    // need it.
    const held = Promise.withResolvers<void>();
    const api = fakeApi({
      uploadStream: vi.fn(async (_id: string, _file, options) => {
        held.resolve();
        // Held open until `reset()` aborts it, rather than never settling: a
        // submission left pending past the end of the spec is a React update
        // landing on an unmounted tree.
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

    await act(async () => {
      void result.current.submit({ recording: pick() });
      await held.promise;
    });

    const [id] = vi.mocked(api.uploadStream).mock.calls[0] ?? [];
    expect(recallUploadId("digest", pick())).toBe(id);
    await act(async () => {
      result.current.reset();
      await Promise.resolve();
    });
  });
});
