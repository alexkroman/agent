// Copyright 2026 the AAI authors. MIT license.
import { afterEach, describe, expect, test } from "vitest";
import { publishUploadReader, stepReadUpload, stepUploadInfo } from "./step-uploads.ts";
import { stepWriteUpload } from "./step-uploads-write.ts";
import { stubUploads } from "./testing-uploads.ts";

describe("stubUploads", () => {
  afterEach(() => publishUploadReader(undefined));

  test("serves the files it was given to a step's reader", async () => {
    stubUploads({ upl_1: new Uint8Array([1, 2, 3]) });

    await expect(stepUploadInfo("upl_1")).resolves.toMatchObject({ size: 3, complete: true });
    expect([...(await stepReadUpload("upl_1")).bytes]).toEqual([1, 2, 3]);
  });

  test("is READ-ONLY by default, so a step that writes cannot do so unnoticed", async () => {
    stubUploads({ upl_1: new Uint8Array([1]) });

    await expect(stepWriteUpload(new Uint8Array([9]))).rejects.toThrow("read-only");
  });

  test("`writable` mints assertable ids and makes what was written readable", async () => {
    stubUploads({}, { writable: true });

    const stored = await stepWriteUpload(new Uint8Array([4, 5]), {
      name: "summary.wav",
      type: "audio/wav",
    });

    expect(stored).toEqual({
      id: "upl_stub_1",
      name: "summary.wav",
      type: "audio/wav",
      size: 2,
      complete: true,
    });
    expect([...(await stepReadUpload(stored.id)).bytes]).toEqual([4, 5]);
  });

  test("counts up, so two writes in one run are distinguishable", async () => {
    stubUploads({}, { writable: true, idPrefix: "wav_" });

    const first = await stepWriteUpload(new Uint8Array([1]));
    const second = await stepWriteUpload(new Uint8Array([2]));

    expect([first.id, second.id]).toEqual(["wav_1", "wav_2"]);
  });

  test("records what a step WROTE, so no spec has to read it back through the slot", async () => {
    // The round trip this replaces: `stepWriteUpload` then `stepUploadInfo`/`stepReadUpload`
    // on the id it returned, through the same published seam the step used, to
    // answer "did it write anything at all".
    const uploads = stubUploads({}, { writable: true });

    await stepWriteUpload(new Uint8Array([4, 5]), { name: "summary.wav", type: "audio/wav" });

    expect(uploads.writes).toEqual([
      { id: "upl_stub_1", name: "summary.wav", type: "audio/wav", bytes: new Uint8Array([4, 5]) },
    ]);
  });

  test("a read-only store records no writes, because it accepted none", async () => {
    const uploads = stubUploads({ upl_1: new Uint8Array([1]) });

    await expect(stepWriteUpload(new Uint8Array([9]))).rejects.toThrow("read-only");
    expect(uploads.writes).toEqual([]);
  });

  test("`read` answers for a seeded file too, synchronously and outside the slot", () => {
    const uploads = stubUploads({ upl_1: { bytes: new Uint8Array([7]), name: "a.wav" } });

    expect(uploads.read("upl_1")).toEqual({
      id: "upl_1",
      name: "a.wav",
      type: "",
      bytes: new Uint8Array([7]),
    });
    expect(uploads.read("upl_nope")).toBeUndefined();
  });

  test("`restore` unpublishes, so the next file's steps do not read these bytes", async () => {
    const uploads = stubUploads({ upl_1: new Uint8Array([1]) });
    uploads.restore();

    // Nothing published: the reader reports there is no store rather than
    // answering with the last file's.
    await expect(stepUploadInfo("upl_1")).rejects.toThrow();
  });
});
