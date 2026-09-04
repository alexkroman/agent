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
  stepReadUpload,
  stepUploadInfo,
  type UploadAccess,
  type UploadWriteMeta,
} from "./step-uploads.ts";
import { stepRequireCompleteUpload } from "./step-uploads-complete.ts";
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

describe("stepReadUpload", () => {
  test("reads the window it was asked for and reports the whole file's size", async () => {
    const reads = publish(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    const slice = await stepReadUpload("upl_1", { start: 2, end: 5 });
    expect([...slice.bytes]).toEqual([3, 4, 5]);
    expect(slice.info.size).toBe(8);
    expect(reads).toEqual([{ start: 2, end: 5 }]);
  });

  test("reads the whole file when no window is named", async () => {
    publish(new Uint8Array([1, 2, 3]));
    const slice = await stepReadUpload("upl_1");
    expect([...slice.bytes]).toEqual([1, 2, 3]);
    expect(slice).toMatchObject({ start: 0, end: 3 });
  });

  test("CLAMPS a window that runs past the end rather than refusing it", async () => {
    // A plan computed from a file's own header legitimately ends one byte past
    // it, and the returned bounds are what say how much was really read.
    const reads = publish(new Uint8Array([1, 2, 3]));
    const slice = await stepReadUpload("upl_1", { start: 1, end: 99 });
    expect([...slice.bytes]).toEqual([2, 3]);
    expect(slice.end).toBe(3);
    expect(reads).toEqual([{ start: 1, end: 3 }]);
  });

  test("answers an empty window without touching the store", async () => {
    const reads = publish(new Uint8Array([1, 2, 3]));
    const slice = await stepReadUpload("upl_1", { start: 2, end: 2 });
    expect(slice.bytes).toHaveLength(0);
    expect(reads).toEqual([]);
  });

  test("never passes NaN to the store, and reads an infinite end to the end", async () => {
    const reads = publish(new Uint8Array([1, 2, 3]));
    await stepReadUpload("upl_1", { start: Number.NaN, end: Number.POSITIVE_INFINITY });
    expect(reads).toEqual([{ start: 0, end: 3 }]);
  });

  test("fails by NAME on an id that names no upload", async () => {
    publish(new Uint8Array(1));
    await expect(stepReadUpload("upl_gone")).rejects.toThrow(/No upload with id upl_gone/);
  });

  test("fails with the fix when no store was published", async () => {
    await expect(stepReadUpload("upl_1")).rejects.toThrow(/No upload store in this process/);
  });
});

/**
 * A parts upload mid-flight: `landed` windows of a `total`-byte file.
 *
 * `size` is the CONTIGUOUS PREFIX, so a file whose first window has not arrived
 * reports zero however much of it is stored. `read` serves whatever the caller
 * asks for, exactly as the real store does — it maps a window onto the objects
 * covering it and never consults the prefix — which is what makes the clamp the
 * only thing under test here.
 */
function publishPartial(total: number, landed: readonly [number, number][]) {
  const bytes = Uint8Array.from({ length: total }, (_unused, at) => at % 251);
  const ranges = landed.map(([start, end]) => ({ start, end }));
  const size = ranges.find((range) => range.start === 0)?.end ?? 0;
  publishUploadReader({
    info: async (id) =>
      id === "upl_1" ? { id, name: "a.wav", type: "", size, complete: false, ranges } : undefined,
    read: async (_id, start, end) => bytes.subarray(start, end),
  });
  return bytes;
}

describe("stepReadUpload against a parts upload still arriving", () => {
  test("reads a landed window the contiguous PREFIX cannot see", async () => {
    // The case this clamp exists for, and the ONE test here that discriminates:
    // the three below are properties the change had to PRESERVE, and each passes
    // against the old prefix-only clamp too.
    //
    // The browser sends `UPLOAD_PART_CONCURRENCY` windows at once, so they share
    // the uplink and land together and the prefix is zero for essentially the
    // whole upload — measured on a deployed agent, a 27 MB recording at 0.9 MB/s
    // reported `size: 0` for 45 of 45 seconds. Clamped to `size`, every read of it
    // came back empty and a run watching the upload had nothing to do until it was
    // over.
    const bytes = publishPartial(64, [[16, 48]]);
    const slice = await stepReadUpload("upl_1", { start: 16, end: 48 });
    expect(slice.info.size).toBe(0);
    expect([...slice.bytes]).toEqual([...bytes.subarray(16, 48)]);
    expect(slice).toMatchObject({ start: 16, end: 48 });
  });

  test("stops at the HOLE a window runs into, rather than reading across it", async () => {
    // A short read, which is the same contract a window past the end of a file
    // already had. Reading across would concatenate two non-adjacent stretches of
    // audio into one buffer — a segment transcribed as something nobody said.
    publishPartial(64, [
      [0, 16],
      [32, 48],
    ]);
    const slice = await stepReadUpload("upl_1", { start: 8, end: 40 });
    expect(slice).toMatchObject({ start: 8, end: 16 });
  });

  test("reads NOTHING from a window that has not landed", async () => {
    publishPartial(64, [[32, 48]]);
    const slice = await stepReadUpload("upl_1", { start: 0, end: 16 });
    expect(slice.bytes.length).toBe(0);
  });

  test("leaves a whole-file upload's clamp exactly as it was", async () => {
    // No `ranges` at all is every upload that did not arrive as parts, and the
    // ceiling has to fall back to the prefix for them or this change would widen
    // a bound it has no business widening.
    publish(new Uint8Array([1, 2, 3]));
    const slice = await stepReadUpload("upl_1", { start: 1, end: 99 });
    expect(slice).toMatchObject({ start: 1, end: 3 });
  });
});

describe("stepUploadInfo", () => {
  test("reports what the uploader declared", async () => {
    publish(new Uint8Array(4));
    await expect(stepUploadInfo("upl_1")).resolves.toEqual({
      id: "upl_1",
      name: "a.wav",
      type: "audio/wav",
      size: 4,
      complete: true,
    });
  });

  test("fails by name on a missing upload", async () => {
    publish(new Uint8Array(1));
    await expect(stepUploadInfo("upl_gone")).rejects.toThrow(/No upload with id/);
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
    const slice = await stepReadUpload("upl_1");
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

describe("stepRequireCompleteUpload", () => {
  test("answers with the record when every byte is in", async () => {
    publish(new Uint8Array([1, 2, 3]));
    expect(await stepRequireCompleteUpload("upl_1")).toMatchObject({ size: 3, complete: true });
  });

  test("refuses one that is still arriving, and names the fix", async () => {
    publish(new Uint8Array([1, 2, 3]), {
      info: async (id) => ({ id, name: "", type: "", size: 3, complete: false }),
    });

    // The sentence is the whole product here: the reader is a step author whose
    // run started a moment too early, and the two supported orders — wait for the
    // upload, or poll it from the body — are what the message has to name.
    await expect(stepRequireCompleteUpload("upl_1")).rejects.toMatchObject({
      name: "UploadIncompleteError",
      // NOT retryable: `toStepError` reads this structurally, so a step ending
      // `.catch(throwStepError)` fails the run rather than spending the budget of
      // the most expensive step in the flow on an upload that will not be there.
      retryable: false,
      // The PREFIX at the moment of the check, which is the number a reader needs
      // to tell "nothing has arrived" from "we were one window short".
      stored: 3,
    });
    await expect(stepRequireCompleteUpload("upl_1")).rejects.toThrow(/ctx\.sleep/);
  });

  test("reports an id that names nothing exactly as stepUploadInfo does", async () => {
    publish(new Uint8Array([1]));
    await expect(stepRequireCompleteUpload("nope")).rejects.toThrow(/No upload with id nope/);
  });
});
