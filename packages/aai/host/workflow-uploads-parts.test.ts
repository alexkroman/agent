// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the PARTS write — one upload arriving over several connections.
 *
 * Split from `workflow-uploads.test.ts` at the 700-line test cap, on the seam the
 * file already had. The shared harness is in `_upload-store-test-utils.ts`; what is
 * here is everything that only makes sense once an upload is declared up front and
 * filled out of order.
 */

import { describe, expect, test } from "vitest";
import { UPLOAD_CHUNK_BYTES } from "../sdk/constants.ts";
import { body, digest, fileStore, ramp, recordingDb } from "./_upload-store-test-utils.ts";
import {
  createUploadStore,
  UnknownUploadError,
  UploadIdTakenError,
  UploadPartError,
  UploadTooLargeError,
} from "./workflow-uploads.ts";

/**
 * The PARTS write, run against BOTH backends by the same body — for the reason the
 * streamed block above is parameterized, and with more riding on it: the two
 * backends answer "how much is contiguous" by completely different means (a window
 * function against a sidecar of merged ranges), so a rule that held in only one of
 * them would be a claim about nothing.
 */
describe.each([
  ["files", async () => await fileStore()],
  ["postgres", async () => createUploadStore({ db: recordingDb().db, dir: "/unused" })],
])("a parts upload (%s backend)", (_label, open) => {
  /** The upload every spec here begins: two whole chunks' worth, declared up front. */
  const TOTAL = UPLOAD_CHUNK_BYTES * 2;

  test("exists from the DECLARATION, incomplete and empty", async () => {
    const store = await open();
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

  test("a part of SEVERAL chunks reads back byte for byte", async () => {
    // Every other spec in this block writes a part of exactly ONE chunk, so the
    // postgres writer's batch was always of size one and nothing here exercised the
    // multi-row statement it commits — which is how a fake that read a fixed
    // `params[1..3]` dropped three chunks in four while the suite stayed green.
    const store = await open();
    // Five chunks: one full batch and a short one, which are the two shapes the
    // statement has to get right.
    const total = UPLOAD_CHUNK_BYTES * 5;
    await store.beginParts("many", {}, total);
    const written = await store.writePart("many", 0, body(ramp(total)));
    expect(written).toMatchObject({ size: total, complete: true });
    // Digests rather than `toEqual`: a deep-equality over five million elements is
    // minutes of vitest, and this tier has a 5s cap.
    expect(digest(await store.read("many", 0, total))).toBe(digest(ramp(total)));
    // And a window straddling two of the batches, where a mis-numbered `seq` reads
    // back as bytes from the wrong offset rather than as missing ones.
    const [from, to] = [UPLOAD_CHUNK_BYTES * 3 + 11, UPLOAD_CHUNK_BYTES * 4 + 13];
    expect(digest(await store.read("many", from, to))).toBe(digest(ramp(to - from, from)));
  });

  test("reassembles parts that arrive OUT OF ORDER", async () => {
    const store = await open();
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
    const store = await open();
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
    const store = await open();
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
    expect(after.ranges).toEqual([
      { start: 0, end: UPLOAD_CHUNK_BYTES },
      { start: UPLOAD_CHUNK_BYTES * 2, end: total },
    ]);
    expect((await store.info("abc"))?.ranges).toEqual(after.ranges);
  });

  test("says nothing about windows once there is nothing left to resume", async () => {
    const store = await open();
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
    const store = await open();
    await store.beginParts("abc", {}, TOTAL);
    await store.writePart("abc", 0, body(ramp(UPLOAD_CHUNK_BYTES)));
    // The failure parts exist to survive: a connection dies and the client sends
    // the window again. A store that appended would double the file.
    await store.writePart("abc", 0, body(ramp(UPLOAD_CHUNK_BYTES)));
    expect(await store.info("abc")).toMatchObject({ size: UPLOAD_CHUNK_BYTES, complete: false });
    expect([...(await store.read("abc", 0, 4))]).toEqual([...ramp(4)]);
  });

  test("refuses a part that does not start on a chunk boundary", async () => {
    const store = await open();
    await store.beginParts("abc", {}, TOTAL);
    // Misaligned: it would have to be stored INSIDE a chunk another part owns, and
    // the alternative to refusing it is reading it back from the wrong place.
    await expect(store.writePart("abc", 7, body(ramp(4)))).rejects.toBeInstanceOf(UploadPartError);
  });

  test("refuses a part that runs past the declared total", async () => {
    const store = await open();
    await store.beginParts("abc", {}, UPLOAD_CHUNK_BYTES);
    await expect(
      store.writePart("abc", 0, body(ramp(UPLOAD_CHUNK_BYTES), ramp(UPLOAD_CHUNK_BYTES))),
    ).rejects.toBeInstanceOf(UploadPartError);
  });

  test("refuses a part for an upload nobody began", async () => {
    const store = await open();
    await expect(store.writePart("abc", 0, body(ramp(4)))).rejects.toBeInstanceOf(
      UnknownUploadError,
    );
  });

  test("refuses to append parts to a STREAMED upload", async () => {
    const store = await open();
    await store.stream("abc", {}, body(ramp(4)));
    // It declared no total, so nothing could ever decide it was complete — which
    // is exactly what makes this a 400 rather than a write that quietly works.
    await expect(store.writePart("abc", 0, body(ramp(4)))).rejects.toBeInstanceOf(UploadPartError);
  });

  test("refuses an id that is already taken", async () => {
    const store = await open();
    await store.beginParts("abc", {}, TOTAL);
    await expect(store.beginParts("abc", {}, TOTAL)).rejects.toBeInstanceOf(UploadIdTakenError);
  });

  test("refuses an id that would escape the store", async () => {
    const store = await open();
    await expect(store.beginParts("../escape", {}, TOTAL)).rejects.toThrow(/Invalid upload id/);
  });

  test("refuses a total past its cap BEFORE a byte is sent", async () => {
    const store = await open();
    // The declaration is the one place an oversized upload can be refused for free
    // — the streamed path can only find out as the bytes arrive.
    await expect(store.beginParts("abc", {}, 500, { limit: 50 })).rejects.toBeInstanceOf(
      UploadTooLargeError,
    );
  });

  test("an upload of NO bytes is complete from the declaration", async () => {
    const store = await open();
    // No part can ever arrive to close it, so anything else is a record a run waits
    // on forever.
    expect(await store.beginParts("abc", {}, 0)).toMatchObject({ size: 0, complete: true });
  });

  test("survives parts written CONCURRENTLY, which is the point of the shape", async () => {
    const store = await open();
    const parts = 4;
    await store.beginParts("abc", {}, UPLOAD_CHUNK_BYTES * parts);
    // All at once and unordered, the way the client sends them. The file backend
    // reads-modifies-writes one sidecar to answer this, so without its lock a
    // part's arrival is silently dropped and `complete` never arrives.
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
});
