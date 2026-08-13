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
import { afterEach, describe, expect, test } from "vitest";
import { UPLOAD_CHUNK_BYTES } from "../sdk/constants.ts";
import type { Db } from "../sdk/db.ts";
import {
  createUploadStore,
  UPLOAD_CHUNKS_TABLE,
  UPLOADS_TABLE,
  UploadTooLargeError,
} from "./workflow-uploads.ts";

/** One body, as the routes hand it over: an async iterable of chunks. */
async function* body(...pieces: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const piece of pieces) yield piece;
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

/** A `Db` that records statements and answers the two reads this store makes. */
function recordingDb() {
  const sql: string[] = [];
  const uploads = new Map<string, { name: string; type: string; size: number }>();
  const chunks: { id: string; offset: number; bytes: Uint8Array }[] = [];
  const db: Db = {
    query: async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => {
      sql.push(text.replace(/\s+/g, " ").trim());
      if (text.includes(`insert into ${UPLOAD_CHUNKS_TABLE}`)) {
        chunks.push({
          id: String(params[0]),
          offset: Number(params[2]),
          bytes: params[3] as Uint8Array,
        });
        return [] as T[];
      }
      if (text.includes(`insert into ${UPLOADS_TABLE}`)) {
        uploads.set(String(params[0]), {
          name: String(params[1]),
          type: String(params[2]),
          size: Number(params[3]),
        });
        return [] as T[];
      }
      if (text.includes(`select id, name, type, size from ${UPLOADS_TABLE}`)) {
        const row = uploads.get(String(params[0]));
        // `bigint` comes back from the driver as a STRING, which is the shape
        // the store has to cope with.
        return (row ? [{ id: params[0], ...row, size: String(row.size) }] : []) as T[];
      }
      if (text.includes("substring")) {
        const [id, start, end] = [String(params[0]), Number(params[1]), Number(params[2])];
        return chunks
          .filter(
            (chunk) =>
              chunk.id === id && chunk.offset < end && chunk.offset + chunk.bytes.length > start,
          )
          .map((chunk) => ({
            part: chunk.bytes.subarray(
              Math.max(start - chunk.offset, 0),
              Math.min(end - chunk.offset, chunk.bytes.length),
            ),
          })) as T[];
      }
      return [] as T[];
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
