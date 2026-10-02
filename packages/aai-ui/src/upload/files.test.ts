// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom
/**
 * `uploadFiles` — storing every `File` a submitted form carries and handing
 * back the input with each one replaced by its upload id.
 *
 * Driven directly against a fake client, so what is asserted is the walk
 * itself: the substitution and its SHAPE, the "1 of 3" numbering, a second
 * walk over the same session, and the three answers `claimId` gives a
 * recalled id. `use-workflow-form-recall.test.ts` runs the recall end to end
 * through `useWorkflowSubmit`; the store's round trip is `recall.test.ts`'s.
 *
 * jsdom for `sessionStorage`, where the recall lives; cleared after every spec
 * so one spec's stored file cannot decide the next one's upload.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { createMockWorkflowApi } from "../_react-test-utils.ts";
import type { UploadStatus } from "../use-workflow-form.ts";
import type { WorkflowApi } from "../workflow-client.ts";
import { createUploadSession, uploadFiles } from "./files.ts";
import { recallUploadId, rememberUploadId } from "./recall.ts";

afterEach(() => {
  sessionStorage.clear();
});

/** A file with a FIXED identity, so the recall can find it again. */
function file(name: string, body = "abcd"): File {
  return new File([body], name, { type: "audio/wav", lastModified: 1 });
}

/** Walk `input` once over a fresh session, recording every report. */
async function walk(api: WorkflowApi, input: unknown, session = createUploadSession("digest")) {
  const reports: UploadStatus[] = [];
  const out = await uploadFiles(api, input, (s) => reports.push(s), undefined, session);
  return { out, reports, session };
}

/** The id each `uploadStream` call was made under, in order. */
function streamedIds(api: WorkflowApi): string[] {
  return vi.mocked(api.uploadStream).mock.calls.map(([id]) => id);
}

describe("uploadFiles", () => {
  test("a non-object input passes through untouched, uploading nothing", async () => {
    const api = createMockWorkflowApi();
    const { out } = await walk(api, "just text");
    expect(out).toBe("just text");
    expect(api.uploadStream).not.toHaveBeenCalled();
  });

  test("a File field becomes the id it was stored under; other fields are untouched", async () => {
    const api = createMockWorkflowApi();
    const recording = file("standup.wav");
    const { out } = await walk(api, { recording, topic: "standup" });

    const [id] = streamedIds(api);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(out).toEqual({ recording: id, topic: "standup" });
    expect(vi.mocked(api.uploadStream).mock.calls[0]?.[1]).toBe(recording);
  });

  test("a multiple field submits a LIST of ids, even holding one file", async () => {
    // The shape follows the field: its schema declares a list.
    const api = createMockWorkflowApi();
    const { out } = await walk(api, { extras: [file("one.wav")] });
    expect(out).toEqual({ extras: streamedIds(api) });
  });

  test("a MIXED array is another field's value and is left exactly as it was", async () => {
    const api = createMockWorkflowApi();
    const mixed = [file("one.wav"), "two"];
    const { out } = await walk(api, { mixed });
    expect(out).toEqual({ mixed });
    expect(api.uploadStream).not.toHaveBeenCalled();
  });

  test("numbers the files across the whole input, counted up front", async () => {
    const api = createMockWorkflowApi({
      uploadStream: vi.fn(async (id: string, _body, opts) => {
        opts?.onProgress?.({ loaded: 4, total: 4, fraction: 1 });
        return { id, name: "", type: "", size: 4, complete: true, url: `/u/${id}` };
      }),
    });
    const { reports } = await walk(api, {
      a: file("a.wav"),
      b: [file("b.wav", "bb"), file("c.wav", "ccc")],
    });
    expect(reports.map((r) => `${r.name} ${r.index}/${r.count}`)).toEqual([
      "a.wav 1/3",
      "b.wav 2/3",
      "c.wav 3/3",
    ]);
    expect(reports.every((r) => r.paused === false)).toBe(true);
  });

  test("passes `parallel` down, and omits it when unasked", async () => {
    const api = createMockWorkflowApi();
    const session = createUploadSession("digest");
    await uploadFiles(api, { a: file("a.wav") }, () => undefined, undefined, session);
    expect(vi.mocked(api.uploadStream).mock.calls[0]?.[2]).not.toHaveProperty("parallel");

    const second = createMockWorkflowApi();
    const parallel = { partBytes: 1024, concurrency: 2 };
    await uploadFiles(
      second,
      { a: file("b.wav") },
      () => undefined,
      parallel,
      createUploadSession("digest"),
    );
    expect(vi.mocked(second.uploadStream).mock.calls[0]?.[2]).toMatchObject({ parallel });
  });

  test("a second walk over the same session sends nothing already stored", async () => {
    // A resumed walk re-enters from the top; a stored file must come back as
    // its id without a byte going out again.
    const api = createMockWorkflowApi();
    const recording = file("standup.wav");
    const first = await walk(api, { recording });
    const again = await walk(api, { recording }, first.session);
    expect(again.out).toEqual(first.out);
    expect(api.uploadStream).toHaveBeenCalledOnce();
  });

  test("remembers the minted id before the first byte leaves", async () => {
    const api = createMockWorkflowApi({
      uploadStream: vi.fn(async (id: string) => {
        // Inside the transfer: the recall must already name this id.
        expect(recallUploadId("digest", recording)).toBe(id);
        return { id, name: "", type: "", size: 4, complete: true, url: `/u/${id}` };
      }),
    });
    const recording = file("standup.wav");
    await walk(api, { recording });
    expect(api.uploadStream).toHaveBeenCalledOnce();
  });
});

describe("a recalled id", () => {
  test("that already finished is reused with no transfer, and reported full", async () => {
    const recording = file("standup.wav");
    rememberUploadId("digest", recording, "upl_done");
    const api = createMockWorkflowApi({
      uploadInfo: vi.fn(async (id: string) => ({
        id,
        name: "standup.wav",
        type: "audio/wav",
        size: 4,
        complete: true,
      })),
    });
    const { out, reports } = await walk(api, { recording });
    expect(out).toEqual({ recording: "upl_done" });
    expect(api.uploadStream).not.toHaveBeenCalled();
    expect(reports).toEqual([
      { name: "standup.wav", index: 1, count: 1, loaded: 4, total: 4, fraction: 1, paused: false },
    ]);
  });

  test("that is unfinished WITH windows is resumed under the same id", async () => {
    const recording = file("standup.wav");
    rememberUploadId("digest", recording, "upl_half");
    const api = createMockWorkflowApi({
      uploadInfo: vi.fn(async (id: string) => ({
        id,
        name: "standup.wav",
        type: "audio/wav",
        size: 2,
        complete: false,
        ranges: [{ start: 0, end: 2 }],
      })),
    });
    const { out } = await walk(api, { recording });
    expect(out).toEqual({ recording: "upl_half" });
    expect(vi.mocked(api.uploadStream).mock.calls[0]).toEqual([
      "upl_half",
      recording,
      expect.objectContaining({ resume: true }),
    ]);
  });

  test("that the store no longer knows is forgotten for a fresh one", async () => {
    const recording = file("standup.wav");
    rememberUploadId("digest", recording, "upl_swept");
    const api = createMockWorkflowApi({
      uploadInfo: vi.fn(async () => {
        throw new Error("404");
      }),
    });
    const { out } = await walk(api, { recording });
    const [fresh] = streamedIds(api);
    expect(fresh).not.toBe("upl_swept");
    expect(out).toEqual({ recording: fresh });
    // And the fresh one is what the next load will find.
    expect(recallUploadId("digest", recording)).toBe(fresh);
    // A fresh id has nothing to resume.
    expect(vi.mocked(api.uploadStream).mock.calls[0]?.[2]).not.toHaveProperty("resume");
  });
});
