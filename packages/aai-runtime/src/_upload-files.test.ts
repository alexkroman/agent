// Copyright 2026 the AAI authors. MIT license.
/**
 * The LOCAL upload home — the one a deployment with no `DATABASE_URL` gets.
 *
 * What these specs are for is the CLAIM that makes it legitimate at all: an
 * upload here is exactly as durable as the runs that read it, because both live
 * in the local workflow world's data directory. So the load-bearing spec is not
 * "a round trip works" — it is that a SECOND store over the same directory finds
 * what the first one stored, which is the `aai dev` restart the deleted file
 * backend could not survive, and the reason this is a directory rather than
 * memory.
 *
 * Temp-directory specs in the unit tier, following `server-static.test.ts` and
 * `workspace-files.test.ts` next door.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UPLOAD_CHUNK_BYTES } from "@alexkroman1/aai/host-internal";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { UploadIdTakenError } from "./_upload-store.ts";
import { body, digest, ramp } from "./_upload-store-test-utils.ts";
import { createUploadStore } from "./workflow-uploads.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "aai-upload-local-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A store over the shared directory — called twice where a restart is the point. */
const localStore = () => createUploadStore({ localDir: dir });

describe("uploads with no database", () => {
  test("stores and reads back a whole file", async () => {
    const store = localStore();
    const bytes = ramp(64);
    const created = await store.create({ name: "a.wav", type: "audio/wav" }, body(bytes));
    expect(created).toMatchObject({ name: "a.wav", size: 64, complete: true });
    expect(digest(await store.read(created.id, 0, 64))).toBe(digest(bytes));
  });

  test("a NEW store over the same directory finds what the last one wrote", async () => {
    // The whole argument for a directory. `aai dev`'s local world keeps its run
    // state in the project, re-enqueues the runs it finds there on start, and a
    // memory-backed upload would be gone for exactly those runs — which is the
    // deleted file backend's failure with the durability mismatch reversed.
    const created = await localStore().create({ name: "a.wav" }, body(ramp(32)));
    const reopened = localStore();
    expect(await reopened.info(created.id)).toMatchObject({ id: created.id, size: 32 });
    expect(digest(await reopened.read(created.id, 0, 32))).toBe(digest(ramp(32)));
  });

  test("a streamed upload is readable before its body ends", async () => {
    const store = localStore();
    const gate = Promise.withResolvers<void>();
    async function* trickle(): AsyncGenerator<Uint8Array> {
      yield ramp(8);
      await gate.promise;
      yield ramp(8, 8);
    }
    const done = store.stream("stream1", { name: "a.wav" }, trickle());
    // The record exists from the first window, incomplete, which is what lets a run
    // be started on an upload that is still arriving.
    await vi.waitFor(async () => {
      expect(await store.info("stream1")).toMatchObject({ complete: false });
    });
    gate.resolve();
    expect(await done).toMatchObject({ size: 16, complete: true });
  });

  test("a parts upload publishes its CONTIGUOUS prefix, never the sum", async () => {
    const store = localStore();
    // Offsets sit on the `UPLOAD_CHUNK_BYTES` grid, which is what makes a part's
    // offset — and so its object's name — unscatterable.
    const part = UPLOAD_CHUNK_BYTES;
    await store.beginParts("parts1", {}, part * 2);
    // The tail first: a size counting what has arrived would tell a reader it may
    // read the hole in front of it.
    const ahead = await store.writePart("parts1", part, body(ramp(part, part)));
    expect(ahead).toMatchObject({ size: 0, complete: false });
    const closed = await store.writePart("parts1", 0, body(ramp(part)));
    expect(closed).toMatchObject({ size: part * 2, complete: true });
    expect(digest(await store.read("parts1", 0, part * 2))).toBe(digest(ramp(part * 2)));
  });

  test("refuses an id already held, even for an identical declaration", async () => {
    const store = localStore();
    await store.beginParts("taken", { name: "a.wav" }, 4);
    await expect(store.beginParts("taken", { name: "a.wav" }, 4)).rejects.toThrow(
      UploadIdTakenError,
    );
  });

  test("a record file that is not usable reads as NO SUCH upload", async () => {
    // Written by us and read after a restart, so a truncated or hand-edited one is
    // representable — and a NaN size would make the contiguous-prefix arithmetic
    // answer nonsense. `info` answering undefined is what the store already knows
    // how to report.
    const store = localStore();
    await store.create({}, body(ramp(4)));
    await writeFile(join(dir, "records", "garbage.json"), "{ not json", "utf-8");
    expect(await store.info("garbage")).toBeUndefined();
  });

  test("keeps the bytes out of the record file", async () => {
    // The same claim the Postgres home's specs make of its parameters: a record is
    // a record. A window is a file of its own, so nothing here holds a megabyte.
    const store = localStore();
    const created = await store.create({ name: "a.wav" }, body(ramp(256)));
    const record = await readFile(join(dir, "records", `${created.id}.json`), "utf-8");
    expect(record.length).toBeLessThan(256);
    expect(JSON.parse(record)).toMatchObject({ name: "a.wav", size: 256 });
  });

  test("refuses an id that would climb out of the directory", async () => {
    // An id reaches a table as a PARAMETER in the Postgres home, which makes it
    // harmless there and a path traversal here.
    const store = localStore();
    await expect(store.info("../../etc/passwd")).rejects.toThrow(/Invalid upload id/);
  });
});

describe("a part re-sent while the first attempt is still draining", () => {
  test("CONCURRENT writes of the same window all succeed, and one of them wins whole", async () => {
    // The scenario this store's own doc names: "a part is re-sent whenever a
    // connection dies mid-flight, and the offset in the key is what makes the
    // repeat addressable." The retry can overlap the original — the server has
    // not necessarily noticed the first socket die — so two writers land on one
    // key at once. Both used a FIXED `<offset>.tmp`, so the first rename moved
    // the shared temp file away and every other writer failed `ENOENT`, which
    // the route answered 500. Measured against `aai dev`: 6 concurrent PUTs of
    // one offset -> five 500s, all `ENOENT ... rename '…/0.tmp' -> '…/0'`.
    //
    // Bytes were never corrupted (one writer's content won wholesale) and must
    // stay that way: the assertion is that nobody FAILS, and that the result is
    // exactly one writer's window rather than a blend of several.
    const store = localStore();
    await store.beginParts("abc", {}, UPLOAD_CHUNK_BYTES);
    const windows = [0, 1, 2, 3, 4, 5].map((n) => new Uint8Array(UPLOAD_CHUNK_BYTES).fill(n));
    const results = await Promise.allSettled(
      windows.map((w) => store.writePart("abc", 0, body(w))),
    );
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected.map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
    const stored = await store.read("abc", 0, UPLOAD_CHUNK_BYTES);
    const bytes = new Uint8Array(stored);
    expect(bytes).toHaveLength(UPLOAD_CHUNK_BYTES);
    // Exactly one writer's window, not a blend.
    expect(new Set(bytes)).toHaveProperty("size", 1);
  });
});
