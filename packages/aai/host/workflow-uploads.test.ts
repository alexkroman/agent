// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the upload store.
 *
 * The FILE backend is driven for real against a temp directory — it is the one
 * `aai dev` uses, and its whole subject is byte offsets, which a fake would
 * only restate. The POSTGRES backend is driven against a recording `Db`,
 * because what can go wrong there is the SQL: whether the chunk rows carry the
 * offsets a later range read selects on, and whether the metadata row is
 * written last.
 */

import { describe, expect, test, vi } from "vitest";
import { UPLOAD_CHUNK_BYTES } from "../sdk/constants.ts";
import { MAX_UPLOAD_RANGES } from "./_upload-store-postgres.ts";
import { body, fileStore, ramp, recordingDb } from "./_upload-store-test-utils.ts";
import {
  contiguousBytes,
  createUploadStore,
  mergeRanges,
  UPLOAD_CHUNKS_TABLE,
  UPLOADS_TABLE,
  UploadIdTakenError,
  UploadTooLargeError,
} from "./workflow-uploads.ts";

describe("the file backend", () => {
  test("stores a file and reads back the window it is asked for", async () => {
    const store = await fileStore();
    const info = await store.create({ name: "a.wav", type: "audio/wav" }, body(ramp(1000)));
    expect(info).toMatchObject({ name: "a.wav", type: "audio/wav", size: 1000 });
    expect(info.id).toMatch(/^upl_/);
    expect([...(await store.read(info.id, 10, 15))]).toEqual([...ramp(5, 10)]);
  });

  test("reassembles a body that arrived in many pieces", async () => {
    const store = await fileStore();
    const info = await store.create({}, body(ramp(3), ramp(3, 3), ramp(4, 6)));
    expect(info.size).toBe(10);
    expect([...(await store.read(info.id, 0, 10))]).toEqual([...ramp(10)]);
  });

  test("spans chunk boundaries, which is where an offset bug would hide", async () => {
    const store = await fileStore();
    const size = UPLOAD_CHUNK_BYTES + 512;
    const info = await store.create({}, body(ramp(size)));
    expect(info.size).toBe(size);
    const window = await store.read(info.id, UPLOAD_CHUNK_BYTES - 4, UPLOAD_CHUNK_BYTES + 4);
    expect([...window]).toEqual([...ramp(8, UPLOAD_CHUNK_BYTES - 4)]);
  });

  test("refuses a body past its cap AS IT ARRIVES, and stores nothing", async () => {
    const store = await fileStore();
    await expect(store.create({}, body(ramp(100)), { limit: 50 })).rejects.toBeInstanceOf(
      UploadTooLargeError,
    );
    // Nothing to find: the metadata row is written last precisely so a failed
    // upload reads as absent rather than as a file that is silently short.
    expect(await store.info("upl_whatever")).toBeUndefined();
  });

  test("answers undefined for an upload that does not exist", async () => {
    const store = await fileStore();
    expect(await store.info("upl_gone")).toBeUndefined();
  });
});

describe("the Postgres backend", () => {
  test("creates its tables once, before anything reads or writes", async () => {
    const { db, sql } = recordingDb();
    const store = createUploadStore({ db, dir: "/unused" });
    await store.create({}, body(ramp(4)));
    await store.info("upl_x");
    expect(sql.filter((one) => one.startsWith("create table")).length).toBe(2);
    // And the column is ADDED by an `alter`, because `create table if not exists`
    // is a no-op against a table that already exists — so this is the only
    // statement that reaches a deployment which stored an upload before streaming
    // existed. Without it every read there fails on an unknown column.
    expect(sql.some((one) => one.includes("add column if not exists complete"))).toBe(true);
  });

  test("writes the metadata row LAST, so a torn upload reads as absent", async () => {
    const { db, sql } = recordingDb();
    const store = createUploadStore({ db, dir: "/unused" });
    await store.create({ name: "a.wav" }, body(ramp(4)));
    const chunkAt = sql.findIndex((one) => one.includes(`insert into ${UPLOAD_CHUNKS_TABLE}`));
    const rowAt = sql.findIndex((one) => one.includes(`insert into ${UPLOADS_TABLE}`));
    expect(chunkAt).toBeGreaterThan(-1);
    expect(rowAt).toBeGreaterThan(chunkAt);
  });

  test("a part costs one statement per BATCH of chunks, not one per chunk", async () => {
    // The claim the batching exists to make, and the one thing no assertion about
    // BYTES can see. A part used to be one awaited round trip per megabyte, which
    // did two things in production: the request body drained only as fast as this
    // app's Postgres committed — so a part that was storing fine looked to the
    // platform's forward like a stalled guest and was aborted at 121-125s — and it
    // held one of four pooled connections for the whole part, taking every other
    // request on that guest from p50 0.43s to 1.34s.
    const { db, sql } = recordingDb();
    const store = createUploadStore({ db, dir: "/unused" });
    const total = UPLOAD_CHUNK_BYTES * 5;
    await store.beginParts("batched", {}, total);
    const before = sql.filter((one) => one.includes(`insert into ${UPLOAD_CHUNKS_TABLE}`)).length;
    await store.writePart("batched", 0, body(ramp(total)));
    const statements =
      sql.filter((one) => one.includes(`insert into ${UPLOAD_CHUNKS_TABLE}`)).length - before;
    // Five chunks at four per statement: two, and strictly fewer than the chunks.
    expect(statements).toBe(2);
    expect(statements).toBeLessThan(5);
  });

  test("the WHOLE-FILE writers batch too, which is where the size publish doubled it", async () => {
    // `create` and `stream` had the same round trip per megabyte the parts writer
    // did, and `stream` had a second one beside it: an `update … set size` after
    // every chunk, on the path a page's upload bar and a streaming run are both
    // waiting on.
    const { db, sql } = recordingDb();
    const store = createUploadStore({ db, dir: "/unused" });
    await store.create({}, body(...Array.from({ length: 4 }, () => ramp(UPLOAD_CHUNK_BYTES))));
    expect(sql.filter((one) => one.includes(`insert into ${UPLOAD_CHUNKS_TABLE}`))).toHaveLength(1);
    expect(sql.filter((one) => one.includes(`update ${UPLOADS_TABLE} set size`))).toHaveLength(0);

    const streamed = recordingDb();
    const other = createUploadStore({ db: streamed.db, dir: "/unused" });
    await other.stream(
      "abc",
      {},
      body(...Array.from({ length: 4 }, () => ramp(UPLOAD_CHUNK_BYTES))),
    );
    // One insert and one size publish for four megabytes, plus the final
    // `complete = true` — not four of each.
    const chunkInserts = streamed.sql.filter((one) =>
      one.includes(`insert into ${UPLOAD_CHUNKS_TABLE}`),
    );
    expect(chunkInserts).toHaveLength(1);
    expect(
      streamed.sql.filter(
        (one) => one.includes(`update ${UPLOADS_TABLE} set size`) && !one.includes("complete"),
      ),
    ).toHaveLength(1);
  });

  test("bounds the windows query, so a sparse upload is not a permanent 500", async () => {
    const { db, sql, chunks } = recordingDb();
    const store = createUploadStore({ db, dir: "/unused" });
    await store.beginParts("sparse", {}, UPLOAD_CHUNK_BYTES * (MAX_UPLOAD_RANGES + 2) * 2);
    // Every OTHER chunk slot, so no two windows merge: one island each, which is
    // the only statement here whose row count the caller decides. `postgres-db.ts`
    // THROWS above `MAX_DB_RESULT_ROWS`, so unbounded meant an upload whose record
    // could never be read again — a 500 on every `GET …/info` and every step's
    // `uploadInfo`, with no way for its owner to correct it.
    for (let at = 0; at < MAX_UPLOAD_RANGES + 2; at += 1) {
      chunks.push({
        id: "sparse",
        seq: at * 2,
        offset: at * 2 * UPLOAD_CHUNK_BYTES,
        bytes: ramp(1),
      });
    }
    const info = await store.info("sparse");
    // Not a throw — and no windows, which is the same answer an agent too old to
    // report them gives, so the client re-sends the whole file rather than trusting
    // a truncated list and leaving a hole.
    expect(info).toMatchObject({ complete: false });
    expect(info?.ranges).toBeUndefined();
    // And the statement asked for one more than the cap, which is how it can tell a
    // full page from an exact fit.
    expect(sql.some((one) => /group by island order by 1 limit \d+/.test(one))).toBe(true);
  });

  test("keeps the per-part write on the ONE-row prefix query", async () => {
    const { db, sql } = recordingDb();
    const store = createUploadStore({ db, dir: "/unused" });
    await store.beginParts("abc", {}, UPLOAD_CHUNK_BYTES * 2);
    const before = sql.length;
    await store.writePart("abc", 0, body(ramp(UPLOAD_CHUNK_BYTES)));
    const walked = sql.slice(before).filter((one) => one.includes("with covered as"));
    // The write path asks for the prefix, never the islands: its row count is one by
    // construction, where the islands query's is a function of how finely the caller
    // cut the file.
    expect(walked).toHaveLength(1);
    expect(walked[0]).toContain("select coalesce(");
    expect(walked[0]).not.toContain("group by island");
  });

  test("turns compression OFF for the chunk column, which audio never pays for", async () => {
    const { db, sql } = recordingDb();
    const store = createUploadStore({ db, dir: "/unused" });
    await store.create({}, body(ramp(4)));
    // `extended` is the default, and it means an LZ attempt on every megabyte of
    // already-compressed or PCM audio — on the one cpu this write path is bounded
    // by.
    expect(sql.some((one) => one.includes("alter column bytes set storage external"))).toBe(true);
  });

  test("stores the chunks anyway when the statement that turns compression off is refused", async () => {
    const { db, chunks } = recordingDb({ refuse: "set storage external" });
    const store = createUploadStore({ db, dir: "/unused" });
    // The `alter` needs table ownership. A store that refused to work because it
    // could not turn an OPTIMIZATION off would be strictly worse than a slower one,
    // so the failure is swallowed — deliberately, and only there.
    await expect(store.create({}, body(ramp(4)))).resolves.toMatchObject({ size: 4 });
    expect(chunks).toHaveLength(1);
  });

  test("records each chunk's byte offset, which is what a range read selects on", async () => {
    const { db, chunks } = recordingDb();
    const store = createUploadStore({ db, dir: "/unused" });
    await store.create({}, body(ramp(UPLOAD_CHUNK_BYTES), ramp(10, UPLOAD_CHUNK_BYTES)));
    expect(chunks.map((chunk) => chunk.offset)).toEqual([0, UPLOAD_CHUNK_BYTES]);
  });

  test("round-trips a window that spans two chunks", async () => {
    const { db } = recordingDb();
    const store = createUploadStore({ db, dir: "/unused" });
    const info = await store.create({}, body(ramp(UPLOAD_CHUNK_BYTES + 8)));
    const window = await store.read(info.id, UPLOAD_CHUNK_BYTES - 2, UPLOAD_CHUNK_BYTES + 2);
    expect([...window]).toEqual([...ramp(4, UPLOAD_CHUNK_BYTES - 2)]);
  });

  test("reads the size back as a NUMBER, not the driver's bigint string", async () => {
    const { db } = recordingDb();
    const store = createUploadStore({ db, dir: "/unused" });
    const info = await store.create({ name: "a.wav" }, body(ramp(7)));
    expect(await store.info(info.id)).toEqual({
      id: info.id,
      name: "a.wav",
      type: "",
      size: 7,
      // True from the moment the record exists, because a `create`d upload does not
      // exist until it is finished — see the module doc.
      complete: true,
    });
  });

  test("deletes the orphan chunks when a body runs past its cap", async () => {
    const { db, sql } = recordingDb();
    const store = createUploadStore({ db, dir: "/unused" });
    await expect(
      store.create({}, body(ramp(UPLOAD_CHUNK_BYTES), ramp(UPLOAD_CHUNK_BYTES)), {
        limit: UPLOAD_CHUNK_BYTES + 1,
      }),
    ).rejects.toBeInstanceOf(UploadTooLargeError);
    expect(sql.some((one) => one.startsWith(`delete from ${UPLOAD_CHUNKS_TABLE}`))).toBe(true);
  });
});

/**
 * The STREAMED write, run against BOTH backends by the same body.
 *
 * Parameterized rather than written twice because the whole value of the file
 * backend is that it is a valid double for the Postgres one — a streaming rule
 * that held in only one of them would make every `aai dev` test a claim about
 * nothing. `describe.each` so the reporter names the backend that failed.
 */
describe.each([
  ["files", async () => await fileStore()],
  ["postgres", async () => createUploadStore({ db: recordingDb().db, dir: "/unused" })],
])("a streamed upload (%s backend)", (_label, open) => {
  /** A body that yields on demand, so a spec can observe the upload mid-flight. */
  function pausableBody(chunks: Uint8Array[]) {
    const gates = chunks.map(() => Promise.withResolvers<void>());
    let at = 0;
    return {
      /** Let the next chunk through. */
      release(index: number) {
        gates[index]?.resolve();
      },
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) {
          await gates[at]?.promise;
          at += 1;
          yield chunk;
        }
      },
    };
  }

  test("exists from the FIRST byte, incomplete, so a run can be started on it", async () => {
    const store = await open();
    const body = pausableBody([ramp(4), ramp(4, 4)]);
    const done = store.stream("abc", { name: "a.wav" }, body);

    // The whole point of this method: the record is readable before the bytes are.
    await vi.waitFor(async () => expect(await store.info("abc")).toBeDefined());
    expect(await store.info("abc")).toMatchObject({ id: "abc", complete: false });

    body.release(0);
    body.release(1);
    await done;
  });

  test("publishes its size a CHUNK at a time, which is what a poll reads", async () => {
    const store = await open();
    // Whole `UPLOAD_CHUNK_BYTES` pieces, because that is the granularity the size
    // advances at: `chunked` buffers until it has a full chunk, so a handful of
    // bytes is not published until the body ends. That is the right trade for the
    // storage layer and it is worth pinning, since it bounds how fresh a polling
    // run's view can be — a megabyte, not a byte.
    //
    // It is also what pins the TIME half of `inBatches`. Writes are grouped, so a
    // backend that only ever flushed a full batch would hold this chunk waiting for
    // three more that are gated behind an assertion — which is the shape of a slow
    // uplink, where `size` not advancing is what an abandonment bound is judged on.
    const body = pausableBody([ramp(UPLOAD_CHUNK_BYTES), ramp(UPLOAD_CHUNK_BYTES)]);
    const done = store.stream("abc", {}, body);
    await vi.waitFor(async () => expect(await store.info("abc")).toBeDefined());

    // ONE gate at a time: the intermediate state is the whole assertion, and
    // releasing both races it away.
    body.release(0);
    await vi.waitFor(async () => expect((await store.info("abc"))?.size).toBe(UPLOAD_CHUNK_BYTES));
    // Still incomplete with a megabyte stored: a size that has stopped growing is
    // not the same claim as a finished file, which is why `complete` is a separate
    // field and the only one a body may exit on.
    expect(await store.info("abc")).toMatchObject({ complete: false });

    body.release(1);
    await done;
    expect(await store.info("abc")).toMatchObject({
      size: UPLOAD_CHUNK_BYTES * 2,
      complete: true,
    });
  });

  test("reads back the bytes that have arrived, and only those", async () => {
    const store = await open();
    const body = pausableBody([ramp(UPLOAD_CHUNK_BYTES), ramp(8, 3)]);
    const done = store.stream("abc", {}, body);
    await vi.waitFor(async () => expect(await store.info("abc")).toBeDefined());
    body.release(0);
    await vi.waitFor(async () => expect((await store.info("abc"))?.size).toBe(UPLOAD_CHUNK_BYTES));

    // The first chunk is readable while the rest is still on the wire, which is the
    // whole mechanism a polling run is built on.
    expect([...(await store.read("abc", 0, 4))]).toEqual([...ramp(4)]);
    body.release(1);
    await done;
    expect([...(await store.read("abc", UPLOAD_CHUNK_BYTES, UPLOAD_CHUNK_BYTES + 8))]).toEqual([
      ...ramp(8, 3),
    ]);
  });

  test("reports no windows, because a whole-file write has none", async () => {
    const store = await open();
    const stored = await store.stream("abc", {}, body(ramp(4)));
    // `ranges` is for an uploader deciding what to re-send, and a single request has
    // nothing to decide: its bytes are one prefix, which `size` already states.
    expect(stored.ranges).toBeUndefined();
    expect((await store.info("abc"))?.ranges).toBeUndefined();
  });

  test("is COMPLETE when it resolves", async () => {
    const store = await open();
    const info = await store.stream("abc", { name: "a.wav", type: "audio/wav" }, body(ramp(10)));
    expect(info).toEqual({ id: "abc", name: "a.wav", type: "audio/wav", size: 10, complete: true });
  });

  test("refuses an id that is already taken, rather than appending to it", async () => {
    const store = await open();
    await store.stream("abc", {}, body(ramp(4)));
    // The safety argument for letting a caller pick the id: a second PUT must not
    // be able to write into somebody else's upload.
    await expect(store.stream("abc", {}, body(ramp(4)))).rejects.toBeInstanceOf(UploadIdTakenError);
    expect((await store.info("abc"))?.size).toBe(4);
  });

  test("refuses an id a `create` already minted", async () => {
    const store = await open();
    const made = await store.create({}, body(ramp(4)));
    await expect(store.stream(made.id, {}, body(ramp(9)))).rejects.toBeInstanceOf(
      UploadIdTakenError,
    );
  });

  test("refuses an id that would escape the store", async () => {
    const store = await open();
    // In the file backend this is a FILENAME, so an unchecked token addresses a
    // path outside the store entirely. Checked in both, so the two cannot disagree.
    await expect(store.stream("../escape", {}, body(ramp(4)))).rejects.toThrow(/Invalid upload id/);
  });

  test("leaves a failed stream INCOMPLETE and readable, not deleted", async () => {
    const store = await open();
    async function* dies() {
      // A whole chunk, so something is actually published before the failure.
      yield ramp(UPLOAD_CHUNK_BYTES);
      throw new Error("client hung up");
    }
    await expect(store.stream("abc", {}, dies())).rejects.toThrow("client hung up");
    // It also pins that a batch HELD when the body died is written before the
    // failure propagates — grouping must not cost a torn upload bytes that had
    // already arrived.
    //
    // The opposite of `create`, deliberately: a reader may already have used the
    // part that arrived, and `complete` is what stops anything mistaking it for
    // the whole file.
    expect(await store.info("abc")).toMatchObject({ size: UPLOAD_CHUNK_BYTES, complete: false });
    expect([...(await store.read("abc", 0, 4))]).toEqual([...ramp(4)]);
  });

  test("refuses a body past its cap AS IT ARRIVES", async () => {
    const store = await open();
    await expect(store.stream("abc", {}, body(ramp(100)), { limit: 50 })).rejects.toBeInstanceOf(
      UploadTooLargeError,
    );
  });
});

describe("merging the windows that have landed", () => {
  test("joins ranges that TOUCH, so a contiguous file is one range", () => {
    // Two parts meeting exactly on a boundary is the ordinary case, and joining
    // them is what makes the contiguous read a single lookup.
    const merged = mergeRanges([{ start: 0, end: 10 }], { start: 10, end: 20 });
    expect(merged).toEqual([{ start: 0, end: 20 }]);
    expect(contiguousBytes(merged)).toBe(20);
  });

  test("keeps a gap a gap, and reports nothing past it", () => {
    const merged = mergeRanges([{ start: 20, end: 30 }], { start: 0, end: 10 });
    expect(merged).toEqual([
      { start: 0, end: 10 },
      { start: 20, end: 30 },
    ]);
    expect(contiguousBytes(merged)).toBe(10);
  });

  test("reports NOTHING when the first byte is missing", () => {
    // However much of the rest has landed: `size` is how far a reader may go.
    expect(contiguousBytes(mergeRanges([], { start: 10, end: 100 }))).toBe(0);
    expect(contiguousBytes([])).toBe(0);
  });
});
