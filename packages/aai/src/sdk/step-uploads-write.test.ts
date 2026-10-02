// Copyright 2026 the AAI authors. MIT license.
import { afterEach, describe, expect, test } from "vitest";
import { publishUploadReader, type UploadAccess, type UploadWriteMeta } from "./step-uploads.ts";
import { stepWriteUpload, UPLOAD_WRITES_UNAVAILABLE_MESSAGE } from "./step-uploads-write.ts";

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

describe("stepWriteUpload", () => {
  test("stores a buffer and answers with the record naming it", async () => {
    const written = publishWritable();

    const stored = await stepWriteUpload(new Uint8Array([1, 2, 3]), {
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

    await stepWriteUpload(new Uint8Array([0x52, 0x49, 0x46, 0x46]));

    expect(written[0]?.meta).toEqual({ name: undefined, type: undefined });
  });

  test("streams a list of chunks in order rather than joining it first", async () => {
    const written = publishWritable();

    await stepWriteUpload([new Uint8Array([1, 2]), new Uint8Array([3])]);

    expect([...(written[0]?.bytes ?? [])]).toEqual([1, 2, 3]);
    expect(written[0]?.chunks).toBe(2);
  });

  test("drops an empty chunk, which several stores read as a window boundary", async () => {
    const written = publishWritable();

    await stepWriteUpload([new Uint8Array([1]), new Uint8Array(0), new Uint8Array([2])]);

    expect(written[0]?.chunks).toBe(2);
    expect([...(written[0]?.bytes ?? [])]).toEqual([1, 2]);
  });

  test("passes an async iterable through, so a large producer is never collected", async () => {
    const written = publishWritable();
    async function* produce() {
      yield new Uint8Array([7]);
      yield new Uint8Array([8]);
    }

    await stepWriteUpload(produce());

    expect([...(written[0]?.bytes ?? [])]).toEqual([7, 8]);
    expect(written[0]?.chunks).toBe(2);
  });

  test("names the READ-ONLY store apart from a process with no store at all", async () => {
    publish(new Uint8Array([1]));

    await expect(stepWriteUpload(new Uint8Array([1]))).rejects.toThrow(
      UPLOAD_WRITES_UNAVAILABLE_MESSAGE,
    );
  });

  test("reports an absent store the way every other reader here does", async () => {
    await expect(stepWriteUpload(new Uint8Array([1]))).rejects.toThrow(/No upload store/);
  });
});
