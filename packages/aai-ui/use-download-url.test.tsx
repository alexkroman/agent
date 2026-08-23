// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom
/**
 * The two failure modes the copied hook existed to avoid are the two this suite
 * is really about — a missing `revokeObjectURL` pins every completed run's blob
 * for the life of the document, and a missing `cancelled` flag renders the
 * FIRST run's audio under the SECOND run's output. Both are invisible in a
 * screenshot and both are one line.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createMockWorkflowApi } from "./_react-test-utils.ts";
import { useDownloadUrl } from "./use-download-url.ts";

/** A client whose only method this hook calls, with the resolution held open. */
function deferredApi() {
  const pending = new Map<string, PromiseWithResolvers<Blob>>();
  const download = vi.fn((id: string) => {
    const slot = Promise.withResolvers<Blob>();
    pending.set(id, slot);
    return slot.promise;
  });
  return {
    // The shared builder rather than a one-method literal behind a double cast:
    // a cast stops reporting the moment `WorkflowApi` grows a method, which is
    // the failure a typed seam exists to prevent.
    api: createMockWorkflowApi({ download }),
    download,
    settle: (id: string, body = id) => pending.get(id)?.resolve(new Blob([body])),
    fail: (id: string, err: unknown) => pending.get(id)?.reject(err),
  };
}

let created: string[];
let revoked: string[];

beforeEach(() => {
  // jsdom implements neither, and the whole subject here is the pairing.
  created = [];
  revoked = [];
  let n = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
    n += 1;
    const url = `blob:mock/${n}`;
    created.push(url);
    return url;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((url: string) => {
    revoked.push(url);
  });
});

describe("useDownloadUrl", () => {
  test("reports idle for no id, and asks for nothing", () => {
    const { api, download } = deferredApi();
    const { result } = renderHook(() => useDownloadUrl(undefined, { api }));
    expect(result.current).toEqual({ pending: false });
    expect(download).not.toHaveBeenCalled();
  });

  test("reports pending while the bytes are in flight, then the URL", async () => {
    // `pending` as its own field is the point: both templates faked it as
    // "neither url nor error", which cannot tell a download in flight from no
    // id at all.
    const { api, settle } = deferredApi();
    const { result } = renderHook(() => useDownloadUrl("up_1", { api }));
    await waitFor(() => expect(result.current.pending).toBe(true));
    expect(result.current.url).toBeUndefined();

    await act(async () => {
      settle("up_1");
    });
    expect(result.current).toEqual({ url: "blob:mock/1", pending: false });
  });

  test("revokes the object URL when the id changes — the blob is not pinned", async () => {
    const { api, settle } = deferredApi();
    const { result, rerender } = renderHook(({ id }) => useDownloadUrl(id, { api }), {
      initialProps: { id: "up_1" as string | undefined },
    });
    await act(async () => {
      settle("up_1");
    });
    expect(result.current.url).toBe("blob:mock/1");

    rerender({ id: "up_2" });
    expect(revoked).toEqual(["blob:mock/1"]);
    await act(async () => {
      settle("up_2");
    });
    expect(result.current.url).toBe("blob:mock/2");
  });

  test("revokes on unmount too, so a page that navigates away frees the blob", async () => {
    const { api, settle } = deferredApi();
    const { result, unmount } = renderHook(() => useDownloadUrl("up_1", { api }));
    await act(async () => {
      settle("up_1");
    });
    expect(result.current.url).toBe("blob:mock/1");
    unmount();
    expect(revoked).toEqual(["blob:mock/1"]);
  });

  test("a stale download that lands last does not overwrite the current one", async () => {
    // The `cancelled` flag. Without it the first run's bytes win by arriving
    // second, and the page plays the previous run's audio.
    const { api, settle } = deferredApi();
    const { result, rerender } = renderHook(({ id }) => useDownloadUrl(id, { api }), {
      initialProps: { id: "old" as string | undefined },
    });
    rerender({ id: "new" });
    await act(async () => {
      settle("new");
    });
    expect(result.current.url).toBe("blob:mock/1");

    await act(async () => {
      settle("old");
    });
    expect(result.current.url).toBe("blob:mock/1");
    // Nothing was allocated for the loser, so nothing of the winner's is freed.
    expect(created).toEqual(["blob:mock/1"]);
    expect(revoked).toEqual([]);
  });

  test("reports the agent's own sentence when the read fails", async () => {
    const { api, fail } = deferredApi();
    const { result } = renderHook(() => useDownloadUrl("gone", { api }));
    await act(async () => {
      fail("gone", new Error("no upload with id gone"));
    });
    expect(result.current).toEqual({ error: "no upload with id gone", pending: false });
  });

  test("a failure that lands after the id moved on is discarded, not rendered", async () => {
    const { api, fail, settle } = deferredApi();
    const { result, rerender } = renderHook(({ id }) => useDownloadUrl(id, { api }), {
      initialProps: { id: "old" as string | undefined },
    });
    rerender({ id: "new" });
    await act(async () => {
      settle("new");
      fail("old", new Error("stale boom"));
    });
    expect(result.current.error).toBeUndefined();
    expect(result.current.url).toBe("blob:mock/1");
  });

  test("clearing the id returns to idle and frees what was showing", async () => {
    const { api, settle } = deferredApi();
    const { result, rerender } = renderHook(({ id }) => useDownloadUrl(id, { api }), {
      initialProps: { id: "up_1" as string | undefined },
    });
    await act(async () => {
      settle("up_1");
    });
    rerender({ id: undefined });
    expect(result.current).toEqual({ pending: false });
    expect(revoked).toEqual(["blob:mock/1"]);
  });

  test("a client rebuilt every render does not restart the download", async () => {
    // The hazard `_workflow-api-ref.ts` exists for, one layer up: the natural
    // call site is `useDownloadUrl(id, { api: createWorkflowApi() })`.
    const { api, download, settle } = deferredApi();
    const { rerender } = renderHook(() => useDownloadUrl("up_1", { api: { ...api } }));
    await act(async () => {
      settle("up_1");
    });
    rerender();
    rerender();
    expect(download).toHaveBeenCalledTimes(1);
  });
});
