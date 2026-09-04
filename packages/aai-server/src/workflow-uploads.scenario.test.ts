// Copyright 2026 the AAI authors. MIT license.
/**
 * Does the upload store's RECORD survive a real Postgres?
 *
 * This suite used to compare two byte backends — chunk rows against files — and
 * every one of its assertions was about the `substring`/`bytea` SQL a range read was
 * written in. Both are gone: bytes are objects behind `UploadBackend`
 * (`aai/host/_upload-blobs.ts` carries why they left the database), and the memory
 * implementation is equivalent to a bucket by construction because that contract is a
 * window read and a length.
 *
 * What is left in Postgres is the RECORD, and it is still the half a recording `Db`
 * cannot be strict about — every field crosses a driver:
 *
 * - **`parts` is `jsonb`, and this suite has already earned its keep twice on that one
 *   column.** `$N::jsonb` with a `JSON.stringify`d parameter stores a jsonb *string*
 *   containing JSON rather than an array (`jsonb_typeof` said `string`), and the first
 *   fix for the resulting crash reached for `parts::text` on a wrong theory about what
 *   the driver returns. A fake can hold neither shape wrong, because a fake holds the
 *   value the author handed it. `jsonb_typeof` is the assertion; see below.
 * - **`size` and `expected` are `bigint`**, which come back as STRINGS. `Number(…)` is
 *   what the store does about it; a fake that stored numbers can only restate its own
 *   choice.
 * - **`on conflict (id) do nothing returning id`** is what refuses a caller-chosen id
 *   that is already taken. A fake decides that with a `Map.has`; Postgres decides it
 *   with a unique index, and only the second one holds under two concurrent claims.
 * - **`create table if not exists` plus `add column if not exists`** is the migration
 *   path for an agent that stored an upload before `parts` existed — the one statement
 *   that reaches such a deployment, and it either works on a real table or it does not.
 *
 * The body is a ramp, so a window's CONTENT identifies its own offset and an agreement
 * between two reads cannot be satisfied by two identical off-by-ones.
 *
 * Self-cleaning: one schema, created and dropped here.
 *
 * ```sh
 * AAI_TEST_PG_URL='postgresql://postgres:postgres@127.0.0.1:5432/postgres' \
 *   pnpm --filter aai-server test:scenario
 * ```
 */

import { createHash } from "node:crypto";
import {
  createMemoryUploadBackend,
  createPostgresDb,
  UPLOADS_TABLE,
  type UploadStore,
} from "@alexkroman1/aai-runtime";
import {
  createUploadStore,
  UPLOAD_CHUNK_BYTES,
  UPLOAD_PART_BYTES,
} from "@alexkroman1/aai-runtime/internal";
import { afterAll, beforeAll, expect, test } from "vitest";
import { describeWithPg, pgUrl } from "./_pg-test-utils.ts";

/** Distinct from every other scenario suite's schema, and not app-shaped. */
const SCHEMA = "wf_uploads_scenario";

/** Several windows' worth, so a boundary list has more than one entry to round-trip. */
const BODY_BYTES = UPLOAD_PART_BYTES * 2 + 1024;

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
  let store: UploadStore;
  /** A second store over the SAME schema, for the claims that need two writers. */
  let rival: UploadStore;
  let wholeId: string;

  beforeAll(async () => {
    db = createPostgresDb({ url: pgUrl() });
    sql = db.query;
    await sql(`drop schema if exists ${SCHEMA} cascade`);
    await sql(`create schema ${SCHEMA}`);
    // `search_path` rather than a qualified table name: that is how the platform
    // provisions an app role, so the store's unqualified SQL is exercised the way a
    // guest runs it.
    appDb = createPostgresDb({ url: `${pgUrl()}?options=-c%20search_path%3D${SCHEMA}` });
    store = createUploadStore({ db: appDb, blobs: createMemoryUploadBackend() });
    rival = createUploadStore({ db: appDb, blobs: createMemoryUploadBackend() });

    wholeId = (await store.create({ name: "call.wav", type: "audio/wav" }, body(ramp(BODY_BYTES))))
      .id;
  });

  afterAll(async () => {
    await sql(`drop schema if exists ${SCHEMA} cascade`).catch(() => undefined);
    await appDb.close();
    await db.close();
  });

  test("a create round-trips through info, with size as a NUMBER", async () => {
    const info = await store.info(wholeId);
    // `toBe`, not `toEqual`: a `bigint` column arrives as a string, and `"8389632"`
    // would satisfy a loose comparison and then be concatenated by every caller that
    // does arithmetic on it.
    expect(info?.size).toBe(BODY_BYTES);
    expect(typeof info?.size).toBe("number");
    expect(info).toMatchObject({ name: "call.wav", type: "audio/wav", complete: true });
  });

  test("stores the boundary list as a jsonb ARRAY, not a string containing one", async () => {
    // **`jsonb_typeof` is the assertion, and its absence is what let a corrupt write
    // reach CI.** `JSON.stringify(parts)` reaches postgres.js as a JSON parameter, so
    // `$N::jsonb` stored the *string* `"[{\"at\":0,…}]"` — `jsonb_typeof` said
    // `string`, and everything that would ever treat the column as a list (an
    // operator's query, `jsonb_array_elements`, an index) saw a scalar. `::text::jsonb`
    // is the fix; this is the only assertion that can tell the two apart, because both
    // round-trip back through `partsOf` looking fine.
    const [kind] = await sql<{ kind: string }>(
      `select jsonb_typeof(parts) as kind from ${SCHEMA}.${UPLOADS_TABLE} where id = $1`,
      [wholeId],
    );
    expect(kind?.kind).toBe("array");

    // And the windows a whole-file write recorded, which is what makes one byte layout
    // serve every route an upload can arrive by. `parts::text` here rather than the
    // driver's parse, so the bytes IN the column are what is compared.
    const [row] = await sql<{ parts: string }>(
      `select parts::text as parts from ${SCHEMA}.${UPLOADS_TABLE} where id = $1`,
      [wholeId],
    );
    expect(JSON.parse(row?.parts ?? "null")).toEqual([
      { at: 0, bytes: UPLOAD_PART_BYTES },
      { at: UPLOAD_PART_BYTES, bytes: UPLOAD_PART_BYTES },
      { at: UPLOAD_PART_BYTES * 2, bytes: 1024 },
    ]);
  });

  test("a window spanning two objects reads back byte for byte", async () => {
    const [from, to] = [UPLOAD_PART_BYTES - 3, UPLOAD_PART_BYTES + 5];
    expect([...(await store.read(wholeId, from, to))]).toEqual([...ramp(to - from, from)]);
  });

  test("the whole body reads back byte for byte", async () => {
    // Digests rather than `toEqual`: a deep equality over eight million elements is
    // minutes of vitest.
    expect(digest(await store.read(wholeId, 0, BODY_BYTES))).toBe(digest(ramp(BODY_BYTES)));
  });

  test("an unknown id is absent rather than an error", async () => {
    expect(await store.info("upl_nothing")).toBeUndefined();
    expect([...(await store.read("upl_nothing", 0, 16))]).toEqual([]);
  });

  test("a window running PAST the end returns what exists and stops", async () => {
    const tail = await store.read(wholeId, BODY_BYTES - 4, BODY_BYTES + 4096);
    expect([...tail]).toEqual([...ramp(4, BODY_BYTES - 4)]);
  });

  test("a taken id is refused by the INDEX, not by a lookup", async () => {
    // Two stores over one schema, which is the shape a fake cannot have: the refusal
    // has to come from the unique index, because a read-then-insert has a window two
    // concurrent claims fit through.
    await store.beginParts("taken", {}, UPLOAD_CHUNK_BYTES);
    await expect(rival.beginParts("taken", {}, UPLOAD_CHUNK_BYTES)).rejects.toThrow(
      /already exists/,
    );
  });

  test("concurrent claims of ONE id leave exactly one winner", async () => {
    const settled = await Promise.allSettled([
      store.beginParts("raced", {}, UPLOAD_CHUNK_BYTES),
      rival.beginParts("raced", {}, UPLOAD_CHUNK_BYTES),
    ]);
    expect(settled.filter((one) => one.status === "fulfilled")).toHaveLength(1);
    const [row] = await sql<{ n: number }>(
      `select count(*)::int as n from ${SCHEMA}.${UPLOADS_TABLE} where id = $1`,
      ["raced"],
    );
    expect(row?.n).toBe(1);
  });

  test("`expected` distinguishes a parts upload from a streamed one, through bigint", async () => {
    await store.beginParts("parted", {}, UPLOAD_CHUNK_BYTES);
    await store.stream("streamed", {}, body(ramp(64)));
    const rows = await sql<{ id: string; expected: string | null }>(
      `select id, expected from ${SCHEMA}.${UPLOADS_TABLE} where id = any($1) order by id`,
      [["parted", "streamed"]],
    );
    // NULL rather than 0 for a streamed upload: it is what the store reads to refuse a
    // part on one, and a 0 would read as "declared, and finished".
    expect(rows).toEqual([
      { id: "parted", expected: String(UPLOAD_CHUNK_BYTES) },
      { id: "streamed", expected: null },
    ]);
    await expect(store.writePart("streamed", 0, body(ramp(4)))).rejects.toThrow(/not begun/);
  });

  test("parts landing OUT OF ORDER leave size as the contiguous prefix", async () => {
    const total = UPLOAD_CHUNK_BYTES * 3;
    await store.beginParts("sparse", {}, total);
    await store.writePart("sparse", UPLOAD_CHUNK_BYTES * 2, body(ramp(UPLOAD_CHUNK_BYTES)));
    // Its bytes are stored and `size` stays 0, because 0 is how far a reader may go.
    expect(await store.info("sparse")).toMatchObject({ size: 0, complete: false });
    // And the gap is REPORTED, out of the same jsonb column — which is the whole
    // reason a resume can skip what already landed instead of sending the file again.
    expect((await store.info("sparse"))?.ranges).toEqual([
      { start: UPLOAD_CHUNK_BYTES * 2, end: total },
    ]);

    await store.writePart("sparse", 0, body(ramp(UPLOAD_CHUNK_BYTES)));
    await store.writePart("sparse", UPLOAD_CHUNK_BYTES, body(ramp(UPLOAD_CHUNK_BYTES)));
    const done = await store.info("sparse");
    expect(done).toMatchObject({ size: total, complete: true });
    // Nothing left to resume, so nothing is said about windows.
    expect(done?.ranges).toBeUndefined();
  });

  test("concurrent parts all land, which is what the merge lock is for", async () => {
    // Every part reads-modifies-writes the same `parts` column, so this is the case a
    // lost update destroys: `complete` would never arrive and the run would wait
    // forever, with nothing reporting a thing.
    const parts = 4;
    await store.beginParts("fanout", {}, UPLOAD_CHUNK_BYTES * parts);
    await Promise.all(
      Array.from({ length: parts }, (_, at) =>
        store.writePart(
          "fanout",
          at * UPLOAD_CHUNK_BYTES,
          body(ramp(UPLOAD_CHUNK_BYTES, at * UPLOAD_CHUNK_BYTES)),
        ),
      ),
    );
    expect(await store.info("fanout")).toMatchObject({
      size: UPLOAD_CHUNK_BYTES * parts,
      complete: true,
    });
  });

  test("a RESENT part is the same part, not a duplicate or a conflict", async () => {
    await store.beginParts("resent", {}, UPLOAD_CHUNK_BYTES * 2);
    await store.writePart("resent", 0, body(ramp(UPLOAD_CHUNK_BYTES)));
    await store.writePart("resent", 0, body(ramp(UPLOAD_CHUNK_BYTES)));
    expect(await store.info("resent")).toMatchObject({
      size: UPLOAD_CHUNK_BYTES,
      complete: false,
    });
    const [row] = await sql<{ parts: string }>(
      `select parts::text as parts from ${SCHEMA}.${UPLOADS_TABLE} where id = $1`,
      ["resent"],
    );
    // ONE entry, not two: the boundary list is keyed by offset, so a retry replaces
    // rather than appends — a list that doubled would report a range twice and, worse,
    // let `contiguousBytes` run past the bytes that exist.
    expect(JSON.parse(row?.parts ?? "null")).toEqual([{ at: 0, bytes: UPLOAD_CHUNK_BYTES }]);
  });

  test("an interrupted body leaves NO upload", async () => {
    async function* dies(): AsyncGenerator<Uint8Array> {
      yield ramp(1024);
      throw new Error("client hung up");
    }
    const before = await sql<{ n: number }>(
      `select count(*)::int as n from ${SCHEMA}.${UPLOADS_TABLE}`,
    );
    await expect(store.create({}, dies())).rejects.toThrow("client hung up");
    const after = await sql<{ n: number }>(
      `select count(*)::int as n from ${SCHEMA}.${UPLOADS_TABLE}`,
    );
    // The row is written LAST precisely so this reads as "there is no such upload"
    // rather than as a file that is silently short.
    expect(after[0]?.n).toBe(before[0]?.n);
  });

  test("a stream that DIES leaves an incomplete, readable upload", async () => {
    async function* dies(): AsyncGenerator<Uint8Array> {
      yield ramp(UPLOAD_PART_BYTES);
      throw new Error("client hung up");
    }
    await expect(store.stream("torn", {}, dies())).rejects.toThrow("client hung up");
    // The opposite of `create`, deliberately: a run may already have transcribed the
    // first half, and `complete` is what stops anything mistaking it for the whole
    // file. `complete` is a real boolean out of the driver, not the string `"false"`.
    const [row] = await sql<{ complete: boolean }>(
      `select complete from ${SCHEMA}.${UPLOADS_TABLE} where id = $1`,
      ["torn"],
    );
    expect(row?.complete).toBe(false);
    expect(await store.info("torn")).toMatchObject({ size: UPLOAD_PART_BYTES, complete: false });
    expect([...(await store.read("torn", 0, 4))]).toEqual([...ramp(4)]);
  });

  test("a body past its cap is refused as it ARRIVES", async () => {
    await expect(store.create({}, body(ramp(4096)), { limit: 1024 })).rejects.toThrow(
      /exceeds 1024 bytes/,
    );
  });
});
