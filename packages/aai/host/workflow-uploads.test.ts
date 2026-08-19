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

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { UPLOAD_CHUNK_BYTES } from "../sdk/constants.ts";
import type { Db } from "../sdk/db.ts";
import { omitUndefined } from "../sdk/omit-undefined.ts";
import {
  contiguousBytes,
  createUploadStore,
  mergeRanges,
  UnknownUploadError,
  UPLOAD_CHUNKS_TABLE,
  UPLOADS_TABLE,
  UploadIdTakenError,
  UploadPartError,
  UploadTooLargeError,
} from "./workflow-uploads.ts";

/** One body, as the routes hand it over: an async iterable of chunks. */
async function* body(...pieces: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const piece of pieces) yield piece;
}

/** The declared total a PARTS claim carries, which a streaming claim does not. */
function declaredTotal(param: unknown): number | undefined {
  return param === undefined ? undefined : Number(param);
}

/** `n` bytes counting up, so a window's CONTENT identifies its offset. */
function ramp(n: number, from = 0): Uint8Array {
  return Uint8Array.from({ length: n }, (_, at) => (from + at) % 251);
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fileStore() {
  const dir = await mkdtemp(join(tmpdir(), "aai-uploads-"));
  dirs.push(dir);
  return createUploadStore({ dir });
}

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

/**
 * A `Db` that records statements and answers the reads this store makes.
 *
 * A handler TABLE rather than an if/else chain, for the reason the workflow API's
 * router uses one: the statement shapes are well past the lint ceiling for
 * cognitive complexity as a chain, and a table makes it visible that every handler
 * is matched by a SUBSTRING of the real SQL — which is what has to keep up when the
 * store's statements change. It has already had to twice, and both times the
 * alternative was a fake silently answering `[]`, i.e. a green suite over a store
 * that reads nothing back.
 */
function recordingDb() {
  const sql: string[] = [];
  const uploads = new Map<
    string,
    { name: string; type: string; size: number; complete: boolean; expected?: number }
  >();
  const chunks: { id: string; seq: number; offset: number; bytes: Uint8Array }[] = [];

  const handlers: readonly { when: string; run: (params: unknown[]) => unknown[] }[] = [
    {
      when: `insert into ${UPLOAD_CHUNKS_TABLE}`,
      run: (params) => {
        const row = {
          id: String(params[0]),
          seq: Number(params[1]),
          offset: Number(params[2]),
          bytes: params[3] as Uint8Array,
        };
        // Keyed by `(upload_id, seq)`, as the table is — the parts writer UPSERTS,
        // so a fake that appended would let a retried part read back doubled.
        const at = chunks.findIndex((one) => one.id === row.id && one.seq === row.seq);
        if (at >= 0) chunks[at] = row;
        else chunks.push(row);
        return [];
      },
    },
    {
      // The contiguous prefix, which the real statement computes with a window
      // function. Computed here by the walk the SQL exists to avoid, so the fake
      // and the statement are independent answers to the same question.
      when: "with covered as",
      run: (params) => {
        const covered = chunks
          .filter((chunk) => chunk.id === String(params[0]))
          .sort((a, b) => a.offset - b.offset);
        let size = 0;
        for (const chunk of covered) {
          if (chunk.offset !== size) break;
          size = chunk.offset + chunk.bytes.length;
        }
        return [{ size: String(size) }];
      },
    },
    {
      // Before the plain size update and the streamed one, whose texts overlap it.
      when: "set size = $2, complete = $3",
      run: (params) => {
        const row = uploads.get(String(params[0]));
        if (row)
          uploads.set(String(params[0]), {
            ...row,
            size: Number(params[1]),
            complete: Boolean(params[2]),
          });
        return [];
      },
    },
    {
      // The two parts reads, which name their columns in their own orders so each
      // is matchable on its own.
      when: "select expected, complete, size",
      run: (params) => {
        const row = uploads.get(String(params[0]));
        return row
          ? [
              {
                expected: row.expected === undefined ? null : String(row.expected),
                complete: row.complete,
                size: String(row.size),
              },
            ]
          : [];
      },
    },
    {
      when: "select name, type, expected, complete",
      run: (params) => {
        const row = uploads.get(String(params[0]));
        return row
          ? [
              {
                name: row.name,
                type: row.type,
                expected: row.expected === undefined ? null : String(row.expected),
                complete: row.complete,
              },
            ]
          : [];
      },
    },
    {
      // The streaming CLAIM. `do nothing` on conflict, so an id that is already
      // taken keeps the row it has — which is what the store reads back to decide.
      when: "on conflict (id) do nothing",
      run: (params) => {
        const id = String(params[0]);
        // `returning id` answers with a row only for a statement that INSERTED —
        // which is what the parts claim reads to refuse a taken id, so a fake that
        // always answered would let two callers declare the same upload.
        if (uploads.has(id)) return [];
        uploads.set(id, {
          name: String(params[1]),
          type: String(params[2]),
          size: 0,
          // The streaming claim passes neither; the parts claim passes both, and
          // a zero-byte upload is complete from the moment it is declared.
          complete: params[4] === true,
          ...omitUndefined({ expected: declaredTotal(params[3]) }),
        });
        return [{ id }];
      },
    },
    {
      when: `insert into ${UPLOADS_TABLE}`,
      run: (params) => {
        uploads.set(String(params[0]), {
          name: String(params[1]),
          type: String(params[2]),
          size: Number(params[3]),
          complete: true,
        });
        return [];
      },
    },
    {
      // Before the plain size update, which its text also contains.
      when: "complete = true where id",
      run: (params) => {
        const row = uploads.get(String(params[0]));
        if (row)
          uploads.set(String(params[0]), { ...row, size: Number(params[1]), complete: true });
        return [];
      },
    },
    {
      when: `update ${UPLOADS_TABLE} set size`,
      run: (params) => {
        const row = uploads.get(String(params[0]));
        if (row) uploads.set(String(params[0]), { ...row, size: Number(params[1]) });
        return [];
      },
    },
    {
      when: "select size, complete",
      run: (params) => {
        const row = uploads.get(String(params[0]));
        // `bigint` comes back from the driver as a STRING, which is the shape the
        // store has to cope with.
        return row ? [{ size: String(row.size), complete: row.complete }] : [];
      },
    },
    {
      when: `from ${UPLOADS_TABLE} where id =`,
      run: (params) => {
        const row = uploads.get(String(params[0]));
        return row ? [{ id: params[0], ...row, size: String(row.size) }] : [];
      },
    },
    {
      when: "substring",
      run: (params) => {
        const [id, start, end] = [String(params[0]), Number(params[1]), Number(params[2])];
        return (
          chunks
            // `order by seq` in the real statement, and it is load-bearing rather
            // than cosmetic: parts land in whatever order the network settles, so a
            // fake answering in INSERTION order reassembles a file whose windows
            // are correct and whose bytes are shuffled.
            .toSorted((a, b) => a.seq - b.seq)
            .filter(
              (chunk) =>
                chunk.id === id && chunk.offset < end && chunk.offset + chunk.bytes.length > start,
            )
            .map((chunk) => ({
              part: chunk.bytes.subarray(
                Math.max(start - chunk.offset, 0),
                Math.min(end - chunk.offset, chunk.bytes.length),
              ),
            }))
        );
      },
    },
  ];

  const db: Db = {
    query: async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => {
      sql.push(text.replace(/\s+/g, " ").trim());
      // First match wins, so the handlers are ordered narrowest-first wherever one
      // statement's text contains another's.
      return (handlers.find((handler) => text.includes(handler.when))?.run(params) ?? []) as T[];
    },
  };
  return { db, sql, chunks, uploads };
}

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
