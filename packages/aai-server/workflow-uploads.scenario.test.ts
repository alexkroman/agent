// Copyright 2026 the AAI authors. MIT license.
/**
 * Does the Postgres upload store return the same bytes the file store does?
 *
 * `createUploadStore` (`aai/host/workflow-uploads.ts`) has two backends, and its
 * own module doc names the Postgres one "the one that matters, because a durable
 * run is precisely the thing that outlives the container that started it". Its
 * unit spec drives the FILE backend for real — reasoning that the subject is byte
 * offsets, "which a fake would only restate" — and drives the Postgres backend
 * against a recording `Db`. But the Postgres backend's subject is byte offsets
 * too. They are just written in SQL, and every one of them is driver-level:
 *
 * ```sql
 * substring(bytes
 *   from (greatest(byte_offset, $2) - byte_offset + 1)::int
 *   for  (least(byte_offset + octet_length(bytes), $3) - greatest(byte_offset, $2))::int)
 * ```
 *
 * Postgres string positions are **1-based**, so that `+ 1` is the whole
 * difference between a correct read and one shifted by a byte; the bounds are
 * per ROW, so one statement answers a range spanning several chunks and each
 * covering chunk contributes a different slice; `byte_offset` is `bigint`
 * compared against JS numbers; `bytes` is `bytea`, arriving as something the code
 * wraps in `new Uint8Array`; and `size` is coerced with `Number(row.size)`
 * because bigint comes back from the driver as a string. A recorder holds JS
 * values and can represent none of it. A header probe returning the wrong 64 KB
 * reads to every caller as a corrupt file — no error anywhere.
 *
 * **So the two arms are compared directly.** The same body goes into both, the
 * same windows come out of both, and every window is additionally checked against
 * the bytes it is supposed to be — the body is a ramp, so its CONTENT identifies
 * its own offset and "these two agree" cannot be satisfied by two identical
 * off-by-ones.
 *
 * `UPLOAD_CHUNK_BYTES` is not on a published subpath, so the chunk size is
 * DISCOVERED from the chunk table the store itself wrote rather than imported.
 * That is what makes the boundary windows real: they are cut at the offsets this
 * build actually chunks on, not at a number this file believes.
 *
 * Self-cleaning: one schema, created and dropped here, plus one temp directory.
 *
 * ```sh
 * AAI_TEST_PG_URL='postgresql://postgres:postgres@127.0.0.1:5432/postgres' \
 *   pnpm --filter aai-server test:scenario
 * ```
 */

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPostgresDb,
  createUploadStore,
  UPLOAD_CHUNKS_TABLE,
  UPLOADS_TABLE,
  type UploadStore,
} from "@alexkroman1/aai/runtime";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { describeWithPg, pgUrl } from "./_pg-test-utils.ts";

/** Distinct from every other scenario suite's schema, and not app-shaped. */
const SCHEMA = "wf_uploads_scenario";

/**
 * Big enough to be several chunks at any plausible chunk size, and small enough
 * that the whole body crosses the wire in a test. The suite asserts it really
 * produced more than one chunk rather than assuming.
 */
const BODY_BYTES = 3 * 1024 * 1024;

/** `n` bytes counting up, so a window's CONTENT identifies its offset. */
function ramp(n: number, from = 0): Uint8Array {
  return Uint8Array.from({ length: n }, (_, at) => (from + at) % 251);
}

/** One body, as the routes hand it over: an async iterable of chunks. */
async function* body(...pieces: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const piece of pieces) yield piece;
}

/** A window's bytes, for an assertion that names megabytes without printing them. */
function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describeWithPg("the workflow upload store over a real Postgres", () => {
  let db: ReturnType<typeof createPostgresDb>;
  let sql: <T = Record<string, unknown>>(q: string, p?: unknown[]) => Promise<T[]>;
  /** A handle whose search_path is the test schema, as a guest's own role is. */
  let appDb: ReturnType<typeof createPostgresDb>;
  let dir: string;
  let pg: UploadStore;
  let files: UploadStore;
  /** The same body in both backends. */
  let pgId: string;
  let fileId: string;
  /** Read off the chunk rows the store wrote — see the module doc. */
  let chunkBytes: number;
  /** How many rows the body split into; floored by a test, not assumed. */
  let chunkCount: number;

  beforeAll(async () => {
    db = createPostgresDb({ url: pgUrl() });
    sql = db.query;
    await sql(`drop schema if exists ${SCHEMA} cascade`);
    await sql(`create schema ${SCHEMA}`);
    // `search_path` rather than a qualified table name: that is how the platform
    // provisions an app role, so the store's unqualified SQL is exercised the way
    // a guest runs it.
    appDb = createPostgresDb({ url: `${pgUrl()}?options=-c%20search_path%3D${SCHEMA}` });
    dir = await mkdtemp(join(tmpdir(), "aai-uploads-scenario-"));

    // The SAME factory both ways: `createUploadStore` picks the backend by
    // whether it was handed a database, which is the split a deployment makes.
    pg = createUploadStore({ db: appDb, dir });
    files = createUploadStore({ dir });

    const meta = { name: "call.wav", type: "audio/wav" };
    pgId = (await pg.create(meta, body(ramp(BODY_BYTES)))).id;
    fileId = (await files.create(meta, body(ramp(BODY_BYTES)))).id;

    const chunks = await sql<{ seq: number; len: number }>(
      `select seq, octet_length(bytes) as len from ${SCHEMA}.${UPLOAD_CHUNKS_TABLE}
       where upload_id = $1 order by seq`,
      [pgId],
    );
    chunkCount = chunks.length;
    chunkBytes = chunks[0]?.len ?? 0;
  });

  afterAll(async () => {
    await appDb.close();
    await sql(`drop schema if exists ${SCHEMA} cascade`);
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * One window, three ways: what Postgres returns, what the file backend
   * returns, and what the ramp says those bytes must be.
   *
   * Comparing all three is what makes an off-by-one falsifiable — two arms
   * agreeing proves only that they are wrong the same way, and the ramp is the
   * independent answer. The comparison is left to the CALLER so the assertions
   * sit inside the test that owns them.
   */
  type Window = { label: string; pg: string; file: string; expected: string };
  const windows = async (ranges: readonly (readonly [number, number])[]): Promise<Window[]> =>
    Promise.all(
      ranges.map(async ([start, end]) => ({
        label: `[${start}, ${end})`,
        pg: digest(await pg.read(pgId, start, end)),
        file: digest(await files.read(fileId, start, end)),
        expected: digest(ramp(Math.max(0, Math.min(end, BODY_BYTES) - start), start)),
      })),
    );

  test("a create round-trips through info, with size as a NUMBER", async () => {
    const info = await pg.info(pgId);
    expect(info).toEqual({
      id: pgId,
      name: "call.wav",
      type: "audio/wav",
      size: BODY_BYTES,
      // True from the moment the record exists, because a `create`d upload does not
      // exist until it is finished — the invariant the streaming block below is the
      // deliberate exception to.
      complete: true,
    });
    // `bigint` arrives from the driver as a string, so the coercion in `info` is
    // the only thing between a byte count and a value that stringifies right and
    // arithmetics wrong. The unit tier's recorder hands back a JS number and
    // cannot pose the question.
    expect(typeof info?.size).toBe("number");
    const raw = await sql<{ t: string }>(
      `select pg_typeof(size)::text as t from ${SCHEMA}.${UPLOADS_TABLE} where id = $1`,
      [pgId],
    );
    expect(raw[0]?.t).toBe("bigint");
  });

  test("an unknown id is absent rather than an error", async () => {
    expect(await pg.info("upl_nosuchupload")).toBeUndefined();
    expect(await files.info("upl_nosuchupload")).toBeUndefined();
  });

  test("the chunk rows carry the offsets a range read selects on", async () => {
    // `byte_offset` is bigint and every predicate in `read` compares it against a
    // JS number. The offsets must be exact and contiguous, or a window lands
    // between two chunks and comes back short with no error.
    const rows = await sql<{ seq: number; byte_offset: string; len: number; t: string }>(
      `select seq, byte_offset, octet_length(bytes) as len, pg_typeof(byte_offset)::text as t
         from ${SCHEMA}.${UPLOAD_CHUNKS_TABLE} where upload_id = $1 order by seq`,
      [pgId],
    );
    // A one-chunk body would make every boundary case below vacuous while still
    // passing, which is the failure a floor exists to prevent.
    expect(chunkCount).toBeGreaterThan(1);
    expect(rows.map((r) => r.seq)).toEqual(rows.map((_, at) => at));
    expect(rows.every((r) => r.t === "bigint")).toBe(true);
    let at = 0;
    for (const row of rows) {
      expect(Number(row.byte_offset)).toBe(at);
      at += row.len;
    }
    expect(at).toBe(BODY_BYTES);
  });

  test("a window wholly inside one chunk", async () => {
    // The easy case, and the one the 1-based `+ 1` is still load-bearing for: a
    // read at offset 1000 of the first chunk starts at `substring` position 1001.
    for (const w of await windows([
      [1000, 1064],
      [0, 16],
    ])) {
      expect.soft(w.pg, `postgres ${w.label}`).toBe(w.expected);
      expect.soft(w.file, `file ${w.label}`).toBe(w.expected);
    }
  });

  test("a window SPANNING a chunk boundary", async () => {
    // The case the whole `substring` arithmetic lives or dies on: two rows match,
    // the first contributes its tail and the second its head, and the per-row
    // bounds are what decide how much of each. Change `+ 1` to `+ 0` and both
    // halves shift by a byte.
    //
    // The last two sit exactly on the seam in each direction, where an
    // inclusive/exclusive slip costs a whole byte at one end and nothing at the
    // other.
    for (const w of await windows([
      [chunkBytes - 4, chunkBytes + 4],
      [chunkBytes - 1, chunkBytes + 1],
      [chunkBytes, chunkBytes + 8],
      [chunkBytes - 8, chunkBytes],
    ])) {
      expect.soft(w.pg, `postgres ${w.label}`).toBe(w.expected);
      expect.soft(w.file, `file ${w.label}`).toBe(w.expected);
    }
  });

  test("a window spanning a WHOLE chunk, so a middle row contributes all of itself", async () => {
    // Three rows match and the middle one is wholly inside the range, which is
    // the only case where `greatest`/`least` both pick the row's own bounds.
    const [w] = await windows([[chunkBytes - 3, 2 * chunkBytes + 3]]);
    expect(w?.pg, `postgres ${w?.label}`).toBe(w?.expected);
    expect(w?.file, `file ${w?.label}`).toBe(w?.expected);
  });

  test("the whole body reads back byte for byte, in both backends", async () => {
    const [w] = await windows([[0, BODY_BYTES]]);
    expect(w?.pg, "postgres, whole body").toBe(w?.expected);
    expect(w?.file, "file, whole body").toBe(w?.expected);
  });

  test("a zero-length window and an out-of-range one are empty, not an error", async () => {
    // `read` is reached from a Range header, so both are ordinary requests. An
    // empty `substring` result and a `where` matching no row have to look the
    // same to the caller.
    expect(await pg.read(pgId, chunkBytes, chunkBytes)).toHaveLength(0);
    expect(await files.read(fileId, chunkBytes, chunkBytes)).toHaveLength(0);
    expect(await pg.read(pgId, BODY_BYTES + 10, BODY_BYTES + 20)).toHaveLength(0);
    expect(await files.read(fileId, BODY_BYTES + 10, BODY_BYTES + 20)).toHaveLength(0);
  });

  test("a window running PAST the end returns what exists and stops", async () => {
    // The last chunk is short, so `least(byte_offset + octet_length(bytes), $3)`
    // is the bound that decides — the one case where the row's own length wins
    // over the caller's request.
    const [w] = await windows([[BODY_BYTES - 4, BODY_BYTES + 100]]);
    expect(w?.pg, `postgres ${w?.label}`).toBe(w?.expected);
    expect(w?.file, `file ${w?.label}`).toBe(w?.expected);
  });

  test("an interrupted body leaves NO upload, and no orphan chunks", async () => {
    // The metadata row is written LAST precisely so "does this upload exist" is
    // answerable by one row that only appears when the bytes are all in. There is
    // no transaction around a multi-megabyte stream, so this is the only thing
    // standing between a caller and a file that is silently short.
    const before = await sql<{ n: number }>(
      `select count(*)::int as n from ${SCHEMA}.${UPLOADS_TABLE}`,
    );

    async function* interrupted(): AsyncGenerator<Uint8Array> {
      yield ramp(chunkBytes);
      throw new Error("connection reset mid-upload");
    }
    await expect(pg.create({ name: "half.wav" }, interrupted())).rejects.toThrow(
      "connection reset mid-upload",
    );

    const after = await sql<{ n: number }>(
      `select count(*)::int as n from ${SCHEMA}.${UPLOADS_TABLE}`,
    );
    expect(after[0]?.n).toBe(before[0]?.n);
    // And the chunks it did write are gone: best-effort, but they are unreachable
    // either way, so an orphan is space nobody can name.
    const orphans = await sql<{ n: number }>(
      `select count(*)::int as n from ${SCHEMA}.${UPLOAD_CHUNKS_TABLE} c
        where not exists (select 1 from ${SCHEMA}.${UPLOADS_TABLE} u where u.id = c.upload_id)`,
    );
    expect(orphans[0]?.n).toBe(0);
  });

  /**
   * The STREAMED write, which only this tier can really see.
   *
   * `stream` is the deliberate exception to "an upload does not exist until all of its
   * bytes do": the record appears at the first byte with `complete: false` and its
   * `size` grows as chunks land, so a run can be started on the id and read what has
   * arrived. Every mechanism in that sentence is driver-level in the Postgres arm — a
   * `boolean` column added by `alter table`, a `bigint` re-read per chunk, and an
   * `insert … on conflict do nothing` plus a read-back standing in for a claim — and
   * the unit tier's recorder holds JS values and can represent none of it.
   *
   * The two backends reach the same guarantees by completely different means (a
   * conflicting insert against an exclusive `open(…, "wx")`), which is the other
   * reason the comparison belongs here.
   */
  test("a streamed upload EXISTS incomplete, then completes, in both backends", async () => {
    // Gated BEFORE the first chunk as well as between them, which is what makes the
    // claim row observable at all: the claim and the first chunk's size update are two
    // statements microseconds apart, so a test that only waits for the record to exist
    // races them — the first draft caught size 0 on one run and a full chunk on the
    // next. Holding the body is the only way to look between them.
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    async function* held() {
      await first.promise;
      yield ramp(chunkBytes);
      await second.promise;
      yield ramp(chunkBytes, chunkBytes);
    }
    const pgDone = pg.stream("streamedpg", { name: "live.wav", type: "audio/wav" }, held());

    // Present before the bytes are, which is the whole point of the method — and the
    // claim row really does carry a size of ZERO, which is what makes "exists before
    // its bytes" a fact rather than a manner of speaking.
    await vi.waitFor(async () => expect(await pg.info("streamedpg")).toBeDefined());
    expect(await pg.info("streamedpg")).toMatchObject({
      complete: false,
      name: "live.wav",
      // Zero, deterministically: nothing has been yielded yet.
      size: 0,
    });

    // Then the size ADVANCES, a chunk at a time.
    first.resolve();
    await vi.waitFor(async () => expect((await pg.info("streamedpg"))?.size).toBe(chunkBytes));
    const partial = await pg.info("streamedpg");
    expect(partial).toMatchObject({ complete: false });
    // A real `bigint` re-read per chunk, coerced back to a number — the same coercion
    // the create path needs, on a value that MOVES.
    expect(typeof partial?.size).toBe("number");
    // And readable to exactly there, which is what a polling run depends on.
    expect(digest(await pg.read("streamedpg", 0, chunkBytes))).toBe(digest(ramp(chunkBytes)));

    second.resolve();
    const finished = await pgDone;
    expect(finished).toMatchObject({ size: chunkBytes * 2, complete: true });
    expect(await pg.info("streamedpg")).toMatchObject({ complete: true });

    // The file backend agrees, by a different mechanism.
    const viaFiles = await files.stream("streamedfs", { name: "live.wav" }, body(ramp(chunkBytes)));
    expect(viaFiles).toMatchObject({ size: chunkBytes, complete: true });
  });

  test("the completed column is a real boolean, not a string", async () => {
    // The column is added by `alter table … add column if not exists`, because the
    // `create table if not exists` above is a no-op against a table that already
    // exists — so this is the only statement that reaches a deployment which stored an
    // upload before streaming existed, and `default true` is what makes those correct.
    const raw = await sql<{ t: string; v: boolean }>(
      `select pg_typeof(complete)::text as t, complete as v
         from ${SCHEMA}.${UPLOADS_TABLE} where id = $1`,
      [pgId],
    );
    expect(raw[0]?.t).toBe("boolean");
    expect(raw[0]?.v).toBe(true);
  });

  test("a taken id is refused rather than appended to, in both backends", async () => {
    // The safety argument for letting a caller choose the id, and the two arms get
    // there differently: Postgres by a conflicting insert plus a read-back, the file
    // backend by an exclusive create. Only this tier runs the first one.
    await pg.stream("takenpg", {}, body(ramp(16)));
    await expect(pg.stream("takenpg", {}, body(ramp(16)))).rejects.toBeInstanceOf(Error);
    expect((await pg.info("takenpg"))?.size).toBe(16);

    await files.stream("takenfs", {}, body(ramp(16)));
    await expect(files.stream("takenfs", {}, body(ramp(16)))).rejects.toBeInstanceOf(Error);
    expect((await files.info("takenfs"))?.size).toBe(16);
  });

  test("a stream that DIES leaves an incomplete, readable upload — not orphan rows", async () => {
    async function* dies() {
      yield ramp(chunkBytes);
      throw new Error("client hung up");
    }
    await expect(pg.stream("diedpg", {}, dies())).rejects.toThrow("client hung up");
    // The opposite of `create`, deliberately: a reader may already have used the part
    // that arrived, so the record stays — and `complete` is what stops anything
    // mistaking it for the whole file.
    expect(await pg.info("diedpg")).toMatchObject({ size: chunkBytes, complete: false });
    expect(digest(await pg.read("diedpg", 0, chunkBytes))).toBe(digest(ramp(chunkBytes)));
    // Its chunk rows are REACHABLE, which is what makes them not orphans — the
    // create path's cleanup query must not count them.
    const rows = await sql<{ n: number }>(
      `select count(*)::int as n from ${SCHEMA}.${UPLOAD_CHUNKS_TABLE} where upload_id = $1`,
      ["diedpg"],
    );
    expect(rows[0]?.n).toBeGreaterThan(0);
  });

  // ─── Parts ──────────────────────────────────────────────────────────────────
  //
  // The parallel-upload path had NO coverage over a real Postgres, which is where
  // it differs most from the file backend: the pg store commits a batch of chunks
  // per statement as one multi-row upsert, and that statement is only safe because
  // a batch's `seq` values are distinct — Postgres refuses an `ON CONFLICT DO
  // UPDATE` that would touch a row twice. Both properties are invisible to the
  // file backend and to a fake, so they are asserted here or nowhere.

  /** One upload, declared then filled window by window. Returns the id. */
  const uploadInParts = async (
    store: UploadStore,
    id: string,
    total: number,
    parts: readonly number[],
  ): Promise<void> => {
    await store.beginParts(id, { name: "call.wav", type: "audio/wav" }, total);
    for (const at of parts) {
      const end = Math.min(at + chunkBytes * 3, total);
      await store.writePart(id, at, body(ramp(end - at, at)));
    }
  };

  test("a parts upload reads back byte for byte, in both backends", async () => {
    // Three parts of three chunks each, so every batch is a MULTI-row statement and
    // the last one is short — the two shapes the batching has to get right.
    const total = chunkBytes * 9;
    const starts = [0, chunkBytes * 3, chunkBytes * 6];
    await uploadInParts(pg, "parts_pg_ordered", total, starts);
    await uploadInParts(files, "parts_file_ordered", total, starts);
    const whole = digest(ramp(total));
    expect(digest(await pg.read("parts_pg_ordered", 0, total))).toBe(whole);
    expect(digest(await files.read("parts_file_ordered", 0, total))).toBe(whole);
    // And a window straddling two batches, which is where a mis-numbered `seq`
    // would show up as bytes from the wrong offset rather than as missing ones.
    const straddle = [chunkBytes * 2 + 17, chunkBytes * 4 + 29] as const;
    expect(digest(await pg.read("parts_pg_ordered", straddle[0], straddle[1]))).toBe(
      digest(ramp(straddle[1] - straddle[0], straddle[0])),
    );
  });

  test("parts landing OUT OF ORDER leave size as the contiguous prefix", async () => {
    // The rule the whole feature rests on: `size` is what a reader may read, so a
    // hole must not be counted even though its bytes arrived.
    const total = chunkBytes * 9;
    await pg.beginParts("parts_pg_holey", { name: "c.wav", type: "audio/wav" }, total);
    const write = async (at: number) =>
      await pg.writePart("parts_pg_holey", at, body(ramp(chunkBytes * 3, at)));
    const third = await write(chunkBytes * 6);
    expect(third).toMatchObject({ size: 0, complete: false });
    const first = await write(0);
    expect(first).toMatchObject({ size: chunkBytes * 3, complete: false });
    const middle = await write(chunkBytes * 3);
    expect(middle).toMatchObject({ size: total, complete: true });
    expect(digest(await pg.read("parts_pg_holey", 0, total))).toBe(digest(ramp(total)));
  });

  test("a RESENT part is the same part, not a duplicate or a conflict", async () => {
    // What the client's one retry depends on, and the reason the batch is an upsert.
    // A bare insert answers a duplicate-key error the caller cannot act on.
    const total = chunkBytes * 3;
    await pg.beginParts("parts_pg_retry", { name: "c.wav", type: "audio/wav" }, total);
    await pg.writePart("parts_pg_retry", 0, body(ramp(total)));
    const again = await pg.writePart("parts_pg_retry", 0, body(ramp(total)));
    expect(again).toMatchObject({ size: total, complete: true });
    const rows = await sql<{ n: number }>(
      `select count(*)::int as n from ${SCHEMA}.${UPLOAD_CHUNKS_TABLE} where upload_id = $1`,
      ["parts_pg_retry"],
    );
    expect(rows[0]?.n).toBe(3);
    expect(digest(await pg.read("parts_pg_retry", 0, total))).toBe(digest(ramp(total)));
  });

  test("a body past its cap is refused as it ARRIVES, in both backends", async () => {
    // The cap is counted as the bytes arrive rather than from a declared length,
    // so the refusal has to happen with chunk rows already written — which is the
    // same cleanup path as the interruption above, reached by the store's own
    // error rather than the caller's.
    const half = ramp(chunkBytes);
    await expect(pg.create({}, body(half, half), { limit: chunkBytes + 1 })).rejects.toBeInstanceOf(
      Error,
    );
    await expect(
      files.create({}, body(half, half), { limit: chunkBytes + 1 }),
    ).rejects.toBeInstanceOf(Error);
    const orphans = await sql<{ n: number }>(
      `select count(*)::int as n from ${SCHEMA}.${UPLOAD_CHUNKS_TABLE} c
        where not exists (select 1 from ${SCHEMA}.${UPLOADS_TABLE} u where u.id = c.upload_id)`,
    );
    expect(orphans[0]?.n).toBe(0);
  });
});
