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
import {
  publishUploadReader,
  readUpload,
  type UploadAccess,
  type UploadWriteMeta,
  uploadInfo,
} from "./step-uploads.ts";
import { UPLOAD_WRITES_UNAVAILABLE_MESSAGE, writeUpload } from "./step-uploads-write.ts";

/** Publish a reader over one in-memory file, recording the windows it is asked for. */
function publish(bytes: Uint8Array, over: Partial<UploadAccess> = {}) {
  const reads: { start: number; end: number }[] = [];
  publishUploadReader({
    info: async (id) =>
      id === "upl_1"
        ? { id, name: "a.wav", type: "audio/wav", size: bytes.length, complete: true }
        : undefined,
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
      complete: true,
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
    const second = vi.fn(async () => ({
      id: "upl_1",
      name: "",
      type: "",
      size: 1,
      complete: true,
    }));
    publishUploadReader({ info: second, read: async () => new Uint8Array([7]) });
    const slice = await readUpload("upl_1");
    expect([...slice.bytes]).toEqual([7]);
    expect(second).toHaveBeenCalled();
  });
});

/** Publish a writable store that collects what it is handed. */
function publishWritable() {
  const written: { meta: UploadWriteMeta; bytes: Uint8Array; chunks: number }[] = [];
  publishUploadReader({
    info: async () => undefined,
    read: async () => new Uint8Array(0),
    create: async (meta, body) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of body) chunks.push(chunk);
      const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.length;
      }
      written.push({ meta, bytes, chunks: chunks.length });
      return {
        id: `upl_written_${written.length}`,
        name: meta.name ?? "",
        type: meta.type ?? "",
        size: bytes.length,
        complete: true,
      };
    },
  });
  return written;
}

describe("writeUpload", () => {
  test("stores a buffer and answers with the record naming it", async () => {
    const written = publishWritable();

    const stored = await writeUpload(new Uint8Array([1, 2, 3]), {
      name: "summary.wav",
      type: "audio/wav",
    });

    expect(stored).toEqual({
      id: "upl_written_1",
      name: "summary.wav",
      type: "audio/wav",
      size: 3,
      complete: true,
    });
    expect([...(written[0]?.bytes ?? [])]).toEqual([1, 2, 3]);
  });

  test("declares nothing the caller did not — no type is sniffed from the bytes", async () => {
    const written = publishWritable();

    await writeUpload(new Uint8Array([0x52, 0x49, 0x46, 0x46]));

    expect(written[0]?.meta).toEqual({ name: undefined, type: undefined });
  });

  test("streams a list of chunks in order rather than joining it first", async () => {
    const written = publishWritable();

    await writeUpload([new Uint8Array([1, 2]), new Uint8Array([3])]);

    expect([...(written[0]?.bytes ?? [])]).toEqual([1, 2, 3]);
    expect(written[0]?.chunks).toBe(2);
  });

  test("drops an empty chunk, which several stores read as a window boundary", async () => {
    const written = publishWritable();

    await writeUpload([new Uint8Array([1]), new Uint8Array(0), new Uint8Array([2])]);

    expect(written[0]?.chunks).toBe(2);
    expect([...(written[0]?.bytes ?? [])]).toEqual([1, 2]);
  });

  test("passes an async iterable through, so a large producer is never collected", async () => {
    const written = publishWritable();
    async function* produce() {
      yield new Uint8Array([7]);
      yield new Uint8Array([8]);
    }

    await writeUpload(produce());

    expect([...(written[0]?.bytes ?? [])]).toEqual([7, 8]);
    expect(written[0]?.chunks).toBe(2);
  });

  test("names the READ-ONLY store apart from a process with no store at all", async () => {
    publish(new Uint8Array([1]));

    await expect(writeUpload(new Uint8Array([1]))).rejects.toThrow(
      UPLOAD_WRITES_UNAVAILABLE_MESSAGE,
    );
  });

  test("reports an absent store the way every other reader here does", async () => {
    await expect(writeUpload(new Uint8Array([1]))).rejects.toThrow(/No upload store/);
  });
});
