// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the step-side upload reader.
 *
 * The subject is the SLOT and the clamping, not storage: a step reads through a
 * published reader, and everything a caller can get wrong here is a boundary —
 * a window past the end of the file, an id that names nothing, a process with
 * no store in it at all.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { publishUploadReader, readUpload, type UploadReader, uploadInfo } from "./step-uploads.ts";

/** Publish a reader over one in-memory file, recording the windows it is asked for. */
function publish(bytes: Uint8Array, over: Partial<UploadReader> = {}) {
  const reads: { start: number; end: number }[] = [];
  publishUploadReader({
    info: async (id) =>
      id === "upl_1" ? { id, name: "a.wav", type: "audio/wav", size: bytes.length } : undefined,
    read: async (_id, start, end) => {
      reads.push({ start, end });
      return bytes.subarray(start, end);
    },
    ...over,
  });
  return reads;
}

// A slot left published would make the next file's steps read this one's bytes.
afterEach(() => publishUploadReader(undefined));

describe("readUpload", () => {
  test("reads the window it was asked for and reports the whole file's size", async () => {
    const reads = publish(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    const slice = await readUpload("upl_1", { start: 2, end: 5 });
    expect([...slice.bytes]).toEqual([3, 4, 5]);
    expect(slice.info.size).toBe(8);
    expect(reads).toEqual([{ start: 2, end: 5 }]);
  });

  test("reads the whole file when no window is named", async () => {
    publish(new Uint8Array([1, 2, 3]));
    const slice = await readUpload("upl_1");
    expect([...slice.bytes]).toEqual([1, 2, 3]);
    expect(slice).toMatchObject({ start: 0, end: 3 });
  });

  test("CLAMPS a window that runs past the end rather than refusing it", async () => {
    // A plan computed from a file's own header legitimately ends one byte past
    // it, and the returned bounds are what say how much was really read.
    const reads = publish(new Uint8Array([1, 2, 3]));
    const slice = await readUpload("upl_1", { start: 1, end: 99 });
    expect([...slice.bytes]).toEqual([2, 3]);
    expect(slice.end).toBe(3);
    expect(reads).toEqual([{ start: 1, end: 3 }]);
  });

  test("answers an empty window without touching the store", async () => {
    const reads = publish(new Uint8Array([1, 2, 3]));
    const slice = await readUpload("upl_1", { start: 2, end: 2 });
    expect(slice.bytes).toHaveLength(0);
    expect(reads).toEqual([]);
  });

  test("never passes NaN to the store, and reads an infinite end to the end", async () => {
    const reads = publish(new Uint8Array([1, 2, 3]));
    await readUpload("upl_1", { start: Number.NaN, end: Number.POSITIVE_INFINITY });
    expect(reads).toEqual([{ start: 0, end: 3 }]);
  });

  test("fails by NAME on an id that names no upload", async () => {
    publish(new Uint8Array(1));
    await expect(readUpload("upl_gone")).rejects.toThrow(/No upload with id upl_gone/);
  });

  test("fails with the fix when no store was published", async () => {
    await expect(readUpload("upl_1")).rejects.toThrow(/No upload store in this process/);
  });
});

describe("uploadInfo", () => {
  test("reports what the uploader declared", async () => {
    publish(new Uint8Array(4));
    await expect(uploadInfo("upl_1")).resolves.toEqual({
      id: "upl_1",
      name: "a.wav",
      type: "audio/wav",
      size: 4,
    });
  });

  test("fails by name on a missing upload", async () => {
    publish(new Uint8Array(1));
    await expect(uploadInfo("upl_gone")).rejects.toThrow(/No upload with id/);
  });
});

describe("publishUploadReader", () => {
  test("REPLACES, so a dev-server restart cannot leave the old store behind", async () => {
    publish(new Uint8Array([9]));
    const second = vi.fn(async () => ({ id: "upl_1", name: "", type: "", size: 1 }));
    publishUploadReader({ info: second, read: async () => new Uint8Array([7]) });
    const slice = await readUpload("upl_1");
    expect([...slice.bytes]).toEqual([7]);
    expect(second).toHaveBeenCalled();
  });
});
