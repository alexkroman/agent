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
import { tick } from "./_test-utils.ts";
import type { UploadBackend } from "./_upload-blobs.ts";
import { body, digest, memoryStore, ramp } from "./_upload-store-test-utils.ts";
import {
  createUploadStore,
  UnknownUploadError,
  UPLOAD_WINDOW_CONCURRENCY,
  UploadCompleteError,
  UploadIdTakenError,
  UploadPartError,
  type UploadStore,
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

  test("names the REAL reason a part offset is refused, not always alignment", async () => {
    const store = open();
    await store.beginParts("abc", {}, TOTAL);
    // `assertPartOffset` refuses three different things and used to report all of
    // them as "not a multiple of 1048576" — which is FALSE for two of them:
    // -1048576 and 1e20 are both exact multiples. A developer told their aligned
    // offset is misaligned checks the arithmetic they got right and is left with
    // nowhere to go. Its own sibling `assertPartTotal` already gives a reason per
    // condition; this matches it.
    await expect(store.writePart("abc", -UPLOAD_CHUNK_BYTES, body(ramp(4)))).rejects.toThrow(
      /negative/i,
    );
    await expect(store.writePart("abc", 1e20, body(ramp(4)))).rejects.toThrow(/whole number/i);
    await expect(store.writePart("abc", 1.5, body(ramp(4)))).rejects.toThrow(/whole number/i);
    // The genuinely misaligned one still says so.
    await expect(store.writePart("abc", 7, body(ramp(4)))).rejects.toThrow(/multiple of/);
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

  test("refuses to REWRITE a window once the upload is complete", async () => {
    // The security property, and it is measured rather than argued: a part write is
    // keyed by its offset and the merge replaces whatever was there, so this used to
    // answer 200, swap the bytes under a finished file, and report nothing. Upload
    // ids are the caller's to choose and the workflow API is unauthenticated unless
    // `AAI_WORKFLOW_API_TOKEN` is set, so it needed no credential.
    const { store } = memoryStore();
    await store.beginParts("abc", {}, TOTAL);
    await store.writePart("abc", 0, body(ramp(UPLOAD_CHUNK_BYTES)));
    const whole = await store.writePart("abc", UPLOAD_CHUNK_BYTES, body(ramp(UPLOAD_CHUNK_BYTES)));
    expect(whole).toMatchObject({ size: TOTAL, complete: true });

    const before = digest(await store.read("abc", 0, TOTAL));
    await expect(
      store.writePart("abc", 0, body(ramp(UPLOAD_CHUNK_BYTES, 99))),
    ).rejects.toBeInstanceOf(UploadCompleteError);
    // The bytes are the ones the record describes, and the record is untouched —
    // including `complete`, which a SHORTER replacement used to flip back to false.
    expect(digest(await store.read("abc", 0, TOTAL))).toBe(before);
    expect(await store.info("abc")).toMatchObject({ size: TOTAL, complete: true });
  });

  test("a re-sent CLAIM on a complete upload is a no-op, not a refusal", async () => {
    // The one write that must not become a 409, because a claim is re-sent on a 5xx
    // or a dropped response and the request that COMPLETED an upload is exactly the
    // one whose answer can be lost. Nothing has changed, so nothing is refused.
    const { store, blobs } = memoryStore();
    await store.beginParts("abc", {}, UPLOAD_CHUNK_BYTES);
    await blobs.put("uploads/abc/0", body(ramp(UPLOAD_CHUNK_BYTES)), { limit: TOTAL });
    const first = await store.recordParts("abc", [0]);
    expect(first).toMatchObject({ size: UPLOAD_CHUNK_BYTES, complete: true });
    await expect(store.recordParts("abc", [0])).resolves.toEqual(first);
  });

  test("refuses a claim that would REPLACE a window of a complete upload", async () => {
    // The same request with the bytes swapped out from under it — a window whose
    // object was rewritten between the two claims. Told apart from the no-op above
    // by the LENGTH the bucket reports, which this path was already probing.
    const { store, blobs } = memoryStore();
    await store.beginParts("abc", {}, UPLOAD_CHUNK_BYTES);
    await blobs.put("uploads/abc/0", body(ramp(UPLOAD_CHUNK_BYTES)), { limit: TOTAL });
    await store.recordParts("abc", [0]);
    await blobs.put("uploads/abc/0", body(ramp(UPLOAD_CHUNK_BYTES - 8)), { limit: TOTAL });
    await expect(store.recordParts("abc", [0])).rejects.toBeInstanceOf(UploadCompleteError);
    expect(await store.info("abc")).toMatchObject({ size: UPLOAD_CHUNK_BYTES, complete: true });
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
    // The production failure this guard was added for. `UploadBackend.size` read a
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

/**
 * What a claim COSTS, which on the direct path is the whole subject.
 *
 * A claim carries no bytes — its entire content is "these windows landed" — so its
 * wall clock is round trips and nothing else, and in a deployed guest each one
 * crosses the platform. Measured on a harness at the production log's own latencies
 * (600 ms per record round trip, 400 ms per probe), one 32-window claim was 5013 ms:
 * three record round trips and eight sequential probe rounds. These specs pin the
 * two structural facts that took it to 1605 ms, because neither is visible in any
 * assertion about the record a claim produces — a slow claim and a fast one leave
 * byte-identical rows.
 */
describe("what a batched claim costs", () => {
  const TOTAL = UPLOAD_CHUNK_BYTES * 8;

  /** An upload with every window of `total` already in the bucket. */
  async function landed(store: UploadStore, blobs: UploadBackend, total: number) {
    await store.beginParts("abc", {}, total);
    const offsets = Array.from(
      { length: total / UPLOAD_CHUNK_BYTES },
      (_, n) => n * UPLOAD_CHUNK_BYTES,
    );
    for (const at of offsets) {
      await blobs.put(`uploads/abc/${at}`, body(ramp(UPLOAD_CHUNK_BYTES)));
    }
    return offsets;
  }

  test("ONE record read and ONE write, however many windows it names", async () => {
    // The claim used to read the record twice: once for the declared total it checks
    // a window against, and again inside the lock for a `parts` list it could trust.
    // Reading INSIDE the lock answers both, because nothing may write this id's
    // parts while it is held — and a declared total cannot go stale at all, being
    // written by `beginParts` and by nothing else ever.
    const { store, blobs, sql } = memoryStore();
    const offsets = await landed(store, blobs, TOTAL);
    const before = sql.length;
    expect(await store.recordParts("abc", offsets)).toMatchObject({
      size: TOTAL,
      complete: true,
    });
    const issued = sql.slice(before);
    expect(issued.filter((text) => text.startsWith("select"))).toHaveLength(1);
    expect(issued.filter((text) => text.includes("set parts = $2"))).toHaveLength(1);
    expect(issued).toHaveLength(2);
  });

  test("and it stays two for a claim of ONE window, which is the unbatched shape", async () => {
    // The saving is per REQUEST rather than per window, so the narrowest claim gains
    // the same round trip the widest one does.
    const { store, blobs, sql } = memoryStore();
    await landed(store, blobs, TOTAL);
    const before = sql.length;
    await store.recordParts("abc", [0]);
    expect(sql.slice(before)).toHaveLength(2);
  });

  test("probes the whole batch in ONE round, not the byte path's four at a time", async () => {
    // `UPLOAD_PROBE_CONCURRENCY`, not `UPLOAD_WINDOW_CONCURRENCY`. The window number
    // is 4 because a window is 8 MiB held in memory until its write acknowledges; a
    // probe is a `HEAD` that moves no bytes, so it meets none of that and paid eight
    // sequential rounds for a limit it does not owe.
    const { store, blobs } = memoryStore();
    const offsets = await landed(store, blobs, TOTAL);
    let live = 0;
    let peak = 0;
    const counting: UploadBackend = {
      ...blobs,
      size: async (key) => {
        live += 1;
        peak = Math.max(peak, live);
        try {
          // A real await, so every probe of one round is in flight together — a
          // synchronous fake would peak at 1 whatever the width.
          await tick();
          return await blobs.size(key);
        } finally {
          live -= 1;
        }
      },
    };
    const store2 = createUploadStore({ db: memoryStore().db, blobs: counting });
    await store2.beginParts("abc", {}, TOTAL);
    await store2.recordParts("abc", offsets);
    expect(peak).toBe(offsets.length);
    expect(offsets.length).toBeGreaterThan(UPLOAD_WINDOW_CONCURRENCY);
  });

  test("still serializes two claims on ONE upload, probes included", async () => {
    // The read moved inside the lock, so the lock is now held across the probes —
    // which is what makes the single read sound. Two claims naming overlapping
    // windows can no longer interleave between measuring and merging, and neither
    // loses the other's windows.
    const { store, blobs } = memoryStore();
    const offsets = await landed(store, blobs, TOTAL);
    const half = offsets.length / 2;
    const [first, second] = await Promise.all([
      store.recordParts("abc", offsets.slice(0, half)),
      store.recordParts("abc", offsets.slice(half)),
    ]);
    // Whichever ran second sees every window; neither dropped the other's.
    expect(Math.max(first.size, second.size)).toBe(TOTAL);
    expect(await store.info("abc")).toMatchObject({ size: TOTAL, complete: true });
  });
});
