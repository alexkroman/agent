// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the PARTS write — one upload arriving over several connections.
 *
 * Split from `workflow-uploads.test.ts` at the 700-line test cap, on the seam the
 * file already had. The shared harness is in `_upload-store-test-utils.ts`; what is
 * here is everything that only makes sense once an upload is declared up front and
 * filled out of order.
 */

import { UPLOAD_CHUNK_BYTES } from "@alexkroman1/aai/host-internal";
import { describe, expect, test } from "vitest";
import { body, digest, memoryStore, ramp } from "./_upload-store-test-utils.ts";
import {
  UnknownUploadError,
  UploadIdTakenError,
  UploadPartError,
  UploadTooLargeError,
} from "./workflow-uploads.ts";

describe("a parts upload", () => {
  /** The upload every spec here begins: two whole chunks' worth, declared up front. */
  const TOTAL = UPLOAD_CHUNK_BYTES * 2;
  /** The store, fresh per spec — recorded rows over in-memory objects. */
  const open = () => memoryStore().store;

  test("exists from the DECLARATION, incomplete and empty", async () => {
    const store = open();
    const begun = await store.beginParts("abc", { name: "a.wav", type: "audio/wav" }, TOTAL);
    expect(begun).toEqual({
      id: "abc",
      name: "a.wav",
      type: "audio/wav",
      size: 0,
      complete: false,
    });
    // Readable by everything else the moment it is declared — which is what lets a
    // run be started on it before a single part has landed.
    expect(await store.info("abc")).toMatchObject({ id: "abc", size: 0, complete: false });
  });

  test("a part of SEVERAL megabytes reads back byte for byte", async () => {
    // Every other spec in this block writes a part of exactly one chunk. A part is
    // stored as ONE object whatever its size — only `create` and `stream` cut a body
    // into windows — so this is the spec that would catch a `put` truncating at a
    // window, or a `read` clamping to one.
    const store = open();
    const total = UPLOAD_CHUNK_BYTES * 5;
    await store.beginParts("many", {}, total);
    const written = await store.writePart("many", 0, body(ramp(total)));
    expect(written).toMatchObject({ size: total, complete: true });
    // Digests rather than `toEqual`: a deep-equality over five million elements is
    // minutes of vitest, and this tier has a 5s cap.
    expect(digest(await store.read("many", 0, total))).toBe(digest(ramp(total)));
    // And a window deep inside it, where an offset bug reads back as bytes from the
    // wrong place rather than as missing ones.
    const [from, to] = [UPLOAD_CHUNK_BYTES * 3 + 11, UPLOAD_CHUNK_BYTES * 4 + 13];
    expect(digest(await store.read("many", from, to))).toBe(digest(ramp(to - from, from)));
  });

  test("reassembles parts that arrive OUT OF ORDER", async () => {
    const store = open();
    await store.beginParts("abc", {}, TOTAL);
    // The second part first, which is the ordinary case rather than an edge one:
    // four requests in flight finish in whatever order the network decides.
    await store.writePart("abc", UPLOAD_CHUNK_BYTES, body(ramp(UPLOAD_CHUNK_BYTES, 7)));
    await store.writePart("abc", 0, body(ramp(UPLOAD_CHUNK_BYTES)));
    expect(await store.info("abc")).toMatchObject({ size: TOTAL, complete: true });
    // Read across the seam, so the assertion is about the ORDER of the bytes and
    // not merely about their number.
    const window = await store.read("abc", UPLOAD_CHUNK_BYTES - 2, UPLOAD_CHUNK_BYTES + 2);
    expect([...window]).toEqual([...ramp(2, UPLOAD_CHUNK_BYTES - 2), ...ramp(2, 7)]);
  });

  test("publishes the CONTIGUOUS prefix, so a hole is never readable", async () => {
    const store = open();
    await store.beginParts("abc", {}, TOTAL);
    // Only the far part. Its bytes are stored, and `size` stays 0 — which is the
    // whole invariant: `size` says how far a reader may go, and reading from zero
    // here would read a hole.
    const after = await store.writePart("abc", UPLOAD_CHUNK_BYTES, body(ramp(UPLOAD_CHUNK_BYTES)));
    expect(after).toMatchObject({ size: 0, complete: false });
    // And it advances over BOTH parts at once when the gap closes, rather than to
    // the end of the part that just landed.
    const filled = await store.writePart("abc", 0, body(ramp(UPLOAD_CHUNK_BYTES)));
    expect(filled).toMatchObject({ size: TOTAL, complete: true });
  });

  test("publishes WHICH windows landed, so a re-send can skip them", async () => {
    const store = open();
    // Three chunks, so a hole can sit between two landed windows.
    const total = UPLOAD_CHUNK_BYTES * 3;
    await store.beginParts("abc", {}, total);
    await store.writePart("abc", 0, body(ramp(UPLOAD_CHUNK_BYTES)));
    const after = await store.writePart(
      "abc",
      UPLOAD_CHUNK_BYTES * 2,
      body(ramp(UPLOAD_CHUNK_BYTES)),
    );
    // The hole is what makes this worth publishing: `size` is 0 past the first
    // window, so nothing else in the record says the third one is already stored —
    // and a client that re-sent the file would send it again.
    expect((await store.info("abc"))?.ranges).toEqual([
      { start: 0, end: UPLOAD_CHUNK_BYTES },
      { start: UPLOAD_CHUNK_BYTES * 2, end: total },
    ]);
    // On the part's own response TOO, which it deliberately was not before. It used
    // to cost a statement whose result set the caller sized — one row per island,
    // against `MAX_DB_RESULT_ROWS` — so a finely-cut sparse upload was a permanently
    // failing read, and keeping the list off the per-part path was the fix. The
    // boundary list is one `jsonb` column the write already reads and merges, so
    // there is nothing left to pay and no reason to withhold it.
    expect(after.ranges).toEqual([
      { start: 0, end: UPLOAD_CHUNK_BYTES },
      { start: UPLOAD_CHUNK_BYTES * 2, end: total },
    ]);
    expect(after).toMatchObject({ size: UPLOAD_CHUNK_BYTES, complete: false });
  });

  test("says nothing about windows once there is nothing left to resume", async () => {
    const store = open();
    await store.beginParts("abc", {}, UPLOAD_CHUNK_BYTES);
    const done = await store.writePart("abc", 0, body(ramp(UPLOAD_CHUNK_BYTES)));
    // A finished upload is covered end to end by construction, so a range list
    // would restate `size` — and the absence is what tells a caller there is no
    // resuming to do.
    expect(done.complete).toBe(true);
    expect(done.ranges).toBeUndefined();
    expect((await store.info("abc"))?.ranges).toBeUndefined();
  });

  test("takes a RETRIED part as the same part, not as a second one", async () => {
    const store = open();
    await store.beginParts("abc", {}, TOTAL);
    await store.writePart("abc", 0, body(ramp(UPLOAD_CHUNK_BYTES)));
    // The failure parts exist to survive: a connection dies and the client sends
    // the window again. A store that appended would double the file.
    await store.writePart("abc", 0, body(ramp(UPLOAD_CHUNK_BYTES)));
    expect(await store.info("abc")).toMatchObject({ size: UPLOAD_CHUNK_BYTES, complete: false });
    expect([...(await store.read("abc", 0, 4))]).toEqual([...ramp(4)]);
  });

  test("refuses a part that does not start on a chunk boundary", async () => {
    const store = open();
    await store.beginParts("abc", {}, TOTAL);
    // Misaligned: the offset IS the object's name, so arbitrary offsets are what let
    // two differently-sized parts overlap at addresses no reader can reconcile.
    await expect(store.writePart("abc", 7, body(ramp(4)))).rejects.toBeInstanceOf(UploadPartError);
  });

  test("refuses a part that runs past the declared total", async () => {
    const store = open();
    await store.beginParts("abc", {}, UPLOAD_CHUNK_BYTES);
    await expect(
      store.writePart("abc", 0, body(ramp(UPLOAD_CHUNK_BYTES), ramp(UPLOAD_CHUNK_BYTES))),
    ).rejects.toBeInstanceOf(UploadPartError);
  });

  test("refuses a part for an upload nobody began", async () => {
    const store = open();
    await expect(store.writePart("abc", 0, body(ramp(4)))).rejects.toBeInstanceOf(
      UnknownUploadError,
    );
  });

  test("refuses to append parts to a STREAMED upload", async () => {
    const store = open();
    await store.stream("abc", {}, body(ramp(4)));
    // It declared no total, so nothing could ever decide it was complete — which
    // is exactly what makes this a 400 rather than a write that quietly works.
    await expect(store.writePart("abc", 0, body(ramp(4)))).rejects.toBeInstanceOf(UploadPartError);
  });

  test("refuses an id that is already taken", async () => {
    const store = open();
    await store.beginParts("abc", {}, TOTAL);
    await expect(store.beginParts("abc", {}, TOTAL)).rejects.toBeInstanceOf(UploadIdTakenError);
  });

  test("refuses an id that would escape the store", async () => {
    const store = open();
    await expect(store.beginParts("../escape", {}, TOTAL)).rejects.toThrow(/Invalid upload id/);
  });

  test("refuses a total past its cap BEFORE a byte is sent", async () => {
    const store = open();
    // The declaration is the one place an oversized upload can be refused for free
    // — the streamed path can only find out as the bytes arrive.
    await expect(store.beginParts("abc", {}, 500, { limit: 50 })).rejects.toBeInstanceOf(
      UploadTooLargeError,
    );
  });

  test("an upload of NO bytes is complete from the declaration", async () => {
    const store = open();
    // No part can ever arrive to close it, so anything else is a record a run waits
    // on forever.
    expect(await store.beginParts("abc", {}, 0)).toMatchObject({ size: 0, complete: true });
  });

  test("survives parts written CONCURRENTLY, which is the point of the shape", async () => {
    const store = open();
    const parts = 4;
    await store.beginParts("abc", {}, UPLOAD_CHUNK_BYTES * parts);
    // All at once and unordered, the way the client sends them. Every part
    // reads-modifies-writes the same `parts` column to answer this, so without the
    // per-id lock an arrival is silently dropped and `complete` never comes.
    await Promise.all(
      Array.from({ length: parts }, (_, at) =>
        store.writePart(
          "abc",
          at * UPLOAD_CHUNK_BYTES,
          body(ramp(UPLOAD_CHUNK_BYTES, at * UPLOAD_CHUNK_BYTES)),
        ),
      ),
    );
    expect(await store.info("abc")).toMatchObject({
      size: UPLOAD_CHUNK_BYTES * parts,
      complete: true,
    });
  });

  test("records a part whose bytes went STRAIGHT to the bucket", async () => {
    // The direct path: the browser sent the window itself, so there is no body here.
    // Indistinguishable from `writePart` in the record it produces, which is what
    // lets the client take either route without the reader knowing.
    const { store, blobs } = memoryStore();
    await store.beginParts("abc", {}, TOTAL);
    await blobs.put(`uploads/abc/${UPLOAD_CHUNK_BYTES}`, body(ramp(UPLOAD_CHUNK_BYTES)));
    await blobs.put("uploads/abc/0", body(ramp(UPLOAD_CHUNK_BYTES)));
    expect(await store.recordParts("abc", [UPLOAD_CHUNK_BYTES])).toMatchObject({ size: 0 });
    expect(await store.recordParts("abc", [0])).toMatchObject({ size: TOTAL, complete: true });
    expect([...(await store.read("abc", 0, 4))]).toEqual([...ramp(4)]);
  });

  test("records SEVERAL windows in one call, which is what a batched claim is", async () => {
    // The batch. One call, one lock acquisition, one whole-array write — and the
    // record it leaves is indistinguishable from the same windows claimed one at a
    // time, which is what lets a client batch or not without a reader knowing.
    const { store, blobs } = memoryStore();
    await store.beginParts("abc", {}, TOTAL);
    await blobs.put("uploads/abc/0", body(ramp(UPLOAD_CHUNK_BYTES)));
    await blobs.put(`uploads/abc/${UPLOAD_CHUNK_BYTES}`, body(ramp(UPLOAD_CHUNK_BYTES)));
    expect(await store.recordParts("abc", [0, UPLOAD_CHUNK_BYTES])).toMatchObject({
      size: TOTAL,
      complete: true,
    });
    expect([...(await store.read("abc", 0, 4))]).toEqual([...ramp(4)]);
  });

  test("records a batch in ANY order, because a claim names what landed", async () => {
    // The offsets arrive in the order the windows finished, which is not the order
    // they sit in the file — so the merge cannot depend on it, and `size` is still
    // the contiguous prefix rather than the sum of what arrived.
    const { store, blobs } = memoryStore();
    await store.beginParts("abc", {}, TOTAL);
    await blobs.put("uploads/abc/0", body(ramp(UPLOAD_CHUNK_BYTES)));
    await blobs.put(`uploads/abc/${UPLOAD_CHUNK_BYTES}`, body(ramp(UPLOAD_CHUNK_BYTES)));
    expect(await store.recordParts("abc", [UPLOAD_CHUNK_BYTES, 0])).toMatchObject({
      size: TOTAL,
      complete: true,
    });
  });

  test("records NONE of a batch holding one part nobody uploaded", async () => {
    // All or nothing, and the order of the checks is what makes it true: every window
    // is measured against the bucket before any is written. Recording the good ones
    // and reporting the bad would leave a client that re-sends the batch unable to
    // tell which half it is repeating.
    const { store, blobs } = memoryStore();
    await store.beginParts("abc", {}, TOTAL);
    await blobs.put("uploads/abc/0", body(ramp(UPLOAD_CHUNK_BYTES)));
    await expect(store.recordParts("abc", [0, UPLOAD_CHUNK_BYTES])).rejects.toBeInstanceOf(
      UploadPartError,
    );
    // The window that WAS in the bucket is not in the record either.
    expect(await store.info("abc")).toMatchObject({ size: 0, complete: false, ranges: [] });
  });

  test("refuses a claim that names the same part twice", async () => {
    // A caller that has lost track of its own windows. The merge would quietly keep
    // whichever copy came last rather than saying so, and a duplicate is the shape a
    // retry-plus-batch bug takes.
    const { store, blobs } = memoryStore();
    await store.beginParts("abc", {}, TOTAL);
    await blobs.put("uploads/abc/0", body(ramp(UPLOAD_CHUNK_BYTES)));
    await expect(store.recordParts("abc", [0, 0])).rejects.toBeInstanceOf(UploadPartError);
  });

  test("refuses a claim that names no parts at all", async () => {
    const store = open();
    await store.beginParts("abc", {}, TOTAL);
    await expect(store.recordParts("abc", [])).rejects.toBeInstanceOf(UploadPartError);
  });

  test("refuses a batch in which ANY offset is misaligned", async () => {
    // The grid rule is per window, and a batch that checked only its first offset
    // would put a part boundary inside a stored chunk for every one after it.
    const { store, blobs } = memoryStore();
    await store.beginParts("abc", {}, TOTAL);
    await blobs.put("uploads/abc/0", body(ramp(UPLOAD_CHUNK_BYTES)));
    await expect(store.recordParts("abc", [0, 1])).rejects.toBeInstanceOf(UploadPartError);
  });

  test("refuses a part nobody uploaded, rather than advancing past a hole", async () => {
    // The whole defence on this path. A client that claimed a part it never sent
    // would move `size` over bytes that are not there, and a step reading them gets
    // SILENCE — a gap in a transcript with nothing anywhere reporting one.
    const store = open();
    await store.beginParts("abc", {}, TOTAL);
    await expect(store.recordParts("abc", [0])).rejects.toBeInstanceOf(UploadPartError);
    expect(await store.info("abc")).toMatchObject({ size: 0, complete: false });
  });

  test("refuses a window the bucket measures as EMPTY, rather than recording a hole", async () => {
    // The production failure this guard was added for. `UploadBlobs.size` read a
    // missing `Content-Length` as `0` (a proxy had zstd-encoded the body-less HEAD),
    // so every window of every parts upload on the platform was recorded as an empty
    // range: well formed, summing to a contiguous 0, and completely unreadable. A
    // zero-length window IS a hole, so it is refused like one.
    const { store, blobs } = memoryStore();
    await store.beginParts("abc", {}, TOTAL);
    await blobs.put("uploads/abc/0", body(new Uint8Array(0)));
    await expect(store.recordParts("abc", [0])).rejects.toBeInstanceOf(UploadPartError);
    expect(await store.info("abc")).toMatchObject({ size: 0, complete: false });
    // And the record holds NO range for it — the refusal is what keeps the row honest.
    expect(await store.info("abc")).toMatchObject({ ranges: [] });
  });

  test("takes the SIZE from the bucket, not from the caller", async () => {
    // Which is the same statement as above from the other side: the record follows
    // what is really stored, so a short object cannot be recorded as a whole part.
    const { store, blobs } = memoryStore();
    await store.beginParts("abc", {}, TOTAL);
    await blobs.put("uploads/abc/0", body(ramp(64)));
    expect(await store.recordParts("abc", [0])).toMatchObject({ size: 64, complete: false });
  });

  test("refuses a recorded part whose object runs past the declared total", async () => {
    const { store, blobs } = memoryStore();
    await store.beginParts("abc", {}, UPLOAD_CHUNK_BYTES);
    await blobs.put("uploads/abc/0", body(ramp(UPLOAD_CHUNK_BYTES + 1)));
    await expect(store.recordParts("abc", [0])).rejects.toBeInstanceOf(UploadPartError);
  });

  test("refuses a recorded part for an upload nobody began", async () => {
    const store = open();
    await expect(store.recordParts("abc", [0])).rejects.toBeInstanceOf(UnknownUploadError);
  });
});
