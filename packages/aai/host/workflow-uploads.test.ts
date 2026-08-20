// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the upload store: the RECORD half.
 *
 * Driven against a recording `Db` and in-memory objects, because what can go wrong
 * here is the record — whether the row appears only once the bytes do, whether the
 * boundary list names the objects a later range read has to reassemble, and whether
 * `size` ever advances past what a reader may read.
 *
 * This suite used to be two: every case ran once over Postgres chunk rows and once
 * over a temp directory, on the argument that the file backend's being a valid double
 * made either trustworthy. There is one store now — `_upload-store-test-utils.ts`
 * carries why that pairing was the wrong axis — and the byte contract it writes
 * through has specs of its own in `_upload-blobs.test.ts`.
 */

import { describe, expect, test, vi } from "vitest";
import { UPLOAD_PART_BYTES } from "../sdk/constants.ts";
import type { UploadBlobs } from "./_upload-blobs.ts";
import { UPLOAD_WINDOW_CONCURRENCY } from "./_upload-store.ts";
import { body, memoryStore, ramp, recordingDb } from "./_upload-store-test-utils.ts";
import {
  createMemoryUploadBlobs,
  createUnavailableUploadStore,
  createUploadStore,
  UPLOADS_TABLE,
  UploadIdTakenError,
  UploadTooLargeError,
} from "./workflow-uploads.ts";

describe("the store", () => {
  test("creates its table once, before anything reads or writes", async () => {
    const { store, sql } = memoryStore();
    await store.create({}, body(ramp(4)));
    await store.info("upl_x");
    expect(sql.filter((one) => one.startsWith("create table"))).toHaveLength(1);
    // And the column is ADDED by an `alter`, because `create table if not exists` is
    // a no-op against a table that already exists — so this is the only statement
    // that reaches a deployment which stored an upload before the boundary list
    // existed. Without it every read there fails on an unknown column.
    expect(sql.some((one) => one.includes("add column if not exists parts"))).toBe(true);
  });

  test("never sends a BYTE to the database", async () => {
    // The claim this whole shape exists to make, and the one no assertion about
    // statement COUNTS can make. Bytes used to go to the WAL and the heap and then
    // into every base backup and the whole PITR window — a 2 GiB recording was well
    // over 4 GiB of durable writes — and they flowed through the same connection
    // pool as the app's own queries, taking every other request on a guest from
    // p50 0.43s to 1.34s while a part was in flight.
    //
    // The spec this replaced counted `insert into …_chunks` statements to show they
    // were batched, which is strictly weaker: a batched write is still a write.
    const { store, params } = memoryStore();
    const created = await store.create({}, body(ramp(UPLOAD_PART_BYTES + 32)));
    await store.beginParts("parted", {}, UPLOAD_PART_BYTES);
    await store.writePart("parted", 0, body(ramp(UPLOAD_PART_BYTES)));
    await store.read(created.id, 0, 8);
    const bytes = params.flat().filter((one) => one instanceof Uint8Array);
    expect(bytes).toEqual([]);
  });

  test("writes the metadata row LAST, so a torn upload reads as absent", async () => {
    const { store, sql, ops } = memoryStore();
    await store.create({ name: "a.wav" }, body(ramp(UPLOAD_PART_BYTES + 4)));
    // Both windows are in the bucket before the row exists. Asserted as "the row is
    // the last thing that happens" rather than by interleaving two recorders: what
    // matters is that nothing can observe the upload until every byte is reachable.
    expect(ops.filter((one) => one.startsWith("put"))).toHaveLength(2);
    expect(sql.at(-1)).toContain(`insert into ${UPLOADS_TABLE}`);
  });

  test("cuts a whole-file write into the SAME windows a parts upload uses", async () => {
    // One byte layout whatever route an upload arrived by — the property
    // `_upload-blobs.ts` states, and the reason `readUpload` needs no idea which
    // write produced an object.
    const whole = memoryStore();
    const created = await whole.store.create({}, body(ramp(UPLOAD_PART_BYTES + 100)));
    expect(await whole.stored(created.id)).toEqual([
      { at: 0, bytes: UPLOAD_PART_BYTES },
      { at: UPLOAD_PART_BYTES, bytes: 100 },
    ]);

    const parts = memoryStore();
    await parts.store.beginParts("same", {}, UPLOAD_PART_BYTES + 100);
    await parts.store.writePart("same", 0, body(ramp(UPLOAD_PART_BYTES)));
    await parts.store.writePart("same", UPLOAD_PART_BYTES, body(ramp(100)));
    expect(await parts.stored("same")).toEqual(await whole.stored(created.id));
  });

  test("round-trips a window that spans two objects", async () => {
    const { store } = memoryStore();
    const info = await store.create({}, body(ramp(UPLOAD_PART_BYTES + 8)));
    const window = await store.read(info.id, UPLOAD_PART_BYTES - 2, UPLOAD_PART_BYTES + 2);
    expect([...window]).toEqual([...ramp(4, UPLOAD_PART_BYTES - 2)]);
  });

  test("reassembles a body that arrived in many pieces", async () => {
    const { store } = memoryStore();
    const info = await store.create({}, body(ramp(3), ramp(3, 3), ramp(4, 6)));
    expect(info.size).toBe(10);
    expect([...(await store.read(info.id, 0, 10))]).toEqual([...ramp(10)]);
  });

  test("reads only the objects a window overlaps", async () => {
    // What makes a header probe cheap: a 64 KB read of a multi-window upload touches
    // one object, not the file.
    const { store, ops, stored } = memoryStore();
    const info = await store.create({}, body(ramp(UPLOAD_PART_BYTES * 3)));
    expect(await stored(info.id)).toHaveLength(3);
    const before = ops.filter((one) => one.startsWith("read")).length;
    await store.read(info.id, 0, 64 * 1024);
    expect(ops.filter((one) => one.startsWith("read")).length - before).toBe(1);
  });

  test("refuses a body past its cap AS IT ARRIVES, and stores nothing", async () => {
    const { store } = memoryStore();
    await expect(store.create({}, body(ramp(100)), { limit: 50 })).rejects.toBeInstanceOf(
      UploadTooLargeError,
    );
    // Nothing to find: the metadata row is written last precisely so a failed upload
    // reads as absent rather than as a file that is silently short. The objects that
    // did land are orphans, which the sweep that is not written will reclaim.
    expect(await store.info("upl_whatever")).toBeUndefined();
  });

  test("answers undefined for an upload that does not exist", async () => {
    const { store } = memoryStore();
    expect(await store.info("upl_gone")).toBeUndefined();
  });

  test("reads the size back as a NUMBER, not the driver's bigint string", async () => {
    const { store } = memoryStore();
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

  test("reads nothing for an id it holds no row for", async () => {
    const { store } = memoryStore();
    expect([...(await store.read("upl_gone", 0, 10))]).toEqual([]);
  });
});

describe("a deployment with nowhere to put uploads", () => {
  test("refuses every operation, naming what is missing", async () => {
    // Never a quiet fallback to a directory or to memory: that WAS the file backend,
    // and it stored a dev upload perfectly well and lost it by the time a resumed run
    // read it, with nothing reporting a thing.
    const store = createUploadStore({});
    await expect(store.create({}, body(ramp(4)))).rejects.toThrow(/DATABASE_URL/);
    await expect(store.create({}, body(ramp(4)))).rejects.toThrow(/AAI_UPLOAD_STORAGE_URL/);
  });

  test("DIAGNOSES only the half that is missing", async () => {
    const { db } = memoryStore();
    const store = createUploadStore({ db });
    const failed = await store
      .beginParts("abc", {}, 4)
      .then(() => expect.fail("the store accepted a claim it has nowhere to store"))
      .catch((err: unknown) => err as Error);
    // The first sentence is the diagnosis and names one half; the `.env` block after it
    // is deliberately COMPLETE, because a reader who has just found the first missing
    // variable is about to find the second.
    const [diagnosis = ""] = failed.message.split(".");
    expect(diagnosis).toContain("AAI_UPLOAD_STORAGE_URL");
    expect(diagnosis).not.toContain("DATABASE_URL");
    expect(failed.message).toContain("supabase status -o env");
  });

  test("names BOTH ways to enable a database, and rules the redeploy out", async () => {
    // This message reaches a browser (a 501 carrying its body) and its reader is
    // usually in the studio, where there is no terminal for `aai storage enable` and
    // the switch is Settings → Database. Naming only the CLI left the studio reader
    // with the one line that sounded like an action — "a DEPLOYED agent gets both
    // from the platform" — and the reported symptom was redeploying against a
    // database that is OFF until the app asks for one.
    const store = createUploadStore({ blobs: createMemoryUploadBlobs() });
    const failed = await store
      .create({}, body(ramp(4)))
      .then(() => expect.fail("the store accepted an upload with nowhere to record it"))
      .catch((err: unknown) => err as Error);
    expect(failed.message).toContain("aai storage enable");
    expect(failed.message).toContain("Settings → Database in the studio");
    // The claim the redeploy loop rested on, stated the other way round.
    expect(failed.message).toMatch(/no redeploy needed/);
  });

  test("refuses the READS too, so a misconfiguration cannot look like a missing id", async () => {
    // `info` answering undefined would make "this platform stores no uploads"
    // indistinguishable from "nobody uploaded that", which is the one confusion an
    // operator cannot debug from outside.
    const store = createUnavailableUploadStore("a bucket");
    await expect(store.info("upl_x")).rejects.toThrow(/a bucket/);
    await expect(store.read("upl_x", 0, 1)).rejects.toThrow(/a bucket/);
  });
});

describe("a streamed upload", () => {
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
    const { store } = memoryStore();
    const streaming = pausableBody([ramp(4), ramp(4, 4)]);
    const done = store.stream("abc", { name: "a.wav" }, streaming);

    // The whole point of this method: the record is readable before the bytes are.
    await vi.waitFor(async () => expect(await store.info("abc")).toBeDefined());
    expect(await store.info("abc")).toMatchObject({ id: "abc", complete: false });

    streaming.release(0);
    streaming.release(1);
    await done;
  });

  test("publishes its size a WINDOW at a time, which is what a poll reads", async () => {
    const { store } = memoryStore();
    // Whole `UPLOAD_PART_BYTES` pieces, because that is the granularity the size
    // advances at: a window is one object, so it is not readable — and therefore not
    // published — until it is whole. That bounds how fresh a polling run's view can
    // be, which is what an abandonment bound is judged on, so it is worth pinning.
    const streaming = pausableBody([ramp(UPLOAD_PART_BYTES), ramp(UPLOAD_PART_BYTES)]);
    const done = store.stream("abc", {}, streaming);
    await vi.waitFor(async () => expect(await store.info("abc")).toBeDefined());

    // ONE gate at a time: the intermediate state is the whole assertion, and
    // releasing both races it away.
    streaming.release(0);
    await vi.waitFor(async () => expect((await store.info("abc"))?.size).toBe(UPLOAD_PART_BYTES));
    // Still incomplete with a window stored: a size that has stopped growing is not
    // the same claim as a finished file, which is why `complete` is a separate field
    // and the only one a body may exit on.
    expect(await store.info("abc")).toMatchObject({ complete: false });

    streaming.release(1);
    await done;
    expect(await store.info("abc")).toMatchObject({
      size: UPLOAD_PART_BYTES * 2,
      complete: true,
    });
  });

  test("reads back the bytes that have arrived, and only those", async () => {
    const { store } = memoryStore();
    const streaming = pausableBody([ramp(UPLOAD_PART_BYTES), ramp(8, 3)]);
    const done = store.stream("abc", {}, streaming);
    await vi.waitFor(async () => expect(await store.info("abc")).toBeDefined());
    streaming.release(0);
    await vi.waitFor(async () => expect((await store.info("abc"))?.size).toBe(UPLOAD_PART_BYTES));

    // The first window is readable while the rest is still on the wire, which is the
    // whole mechanism a polling run is built on.
    expect([...(await store.read("abc", 0, 4))]).toEqual([...ramp(4)]);
    streaming.release(1);
    await done;
    expect([...(await store.read("abc", UPLOAD_PART_BYTES, UPLOAD_PART_BYTES + 8))]).toEqual([
      ...ramp(8, 3),
    ]);
  });

  test("reports no windows, because a whole-file write has none to decide about", async () => {
    const { store } = memoryStore();
    const stored = await store.stream("abc", {}, body(ramp(4)));
    // `ranges` is for an uploader deciding what to re-send, and a single request has
    // nothing to decide: its bytes are one prefix, which `size` already states.
    expect(stored.ranges).toBeUndefined();
    expect((await store.info("abc"))?.ranges).toBeUndefined();
  });

  test("is COMPLETE when it resolves", async () => {
    const { store } = memoryStore();
    const info = await store.stream("abc", { name: "a.wav", type: "audio/wav" }, body(ramp(10)));
    expect(info).toEqual({ id: "abc", name: "a.wav", type: "audio/wav", size: 10, complete: true });
  });

  test("refuses an id that is already taken, rather than appending to it", async () => {
    const { store } = memoryStore();
    await store.stream("abc", {}, body(ramp(4)));
    // The safety argument for letting a caller pick the id: a second PUT must not be
    // able to write into somebody else's upload.
    await expect(store.stream("abc", {}, body(ramp(4)))).rejects.toBeInstanceOf(UploadIdTakenError);
    expect((await store.info("abc"))?.size).toBe(4);
  });

  test("refuses an id a `create` already minted", async () => {
    const { store } = memoryStore();
    const made = await store.create({}, body(ramp(4)));
    await expect(store.stream(made.id, {}, body(ramp(9)))).rejects.toBeInstanceOf(
      UploadIdTakenError,
    );
  });

  test("refuses an id that would escape this deployment's prefix", async () => {
    const { store } = memoryStore();
    // The id is part of an object KEY, so a token that escaped the check would
    // address another agent's objects. Checked at the ROUTE and again here, because
    // the store is also reachable from a step and from a test.
    await expect(store.stream("../escape", {}, body(ramp(4)))).rejects.toThrow(/Invalid upload id/);
  });

  test("leaves a failed stream INCOMPLETE and readable, not deleted", async () => {
    const { store } = memoryStore();
    async function* dies() {
      // A whole window, so something is actually published before the failure.
      yield ramp(UPLOAD_PART_BYTES);
      throw new Error("client hung up");
    }
    await expect(store.stream("abc", {}, dies())).rejects.toThrow("client hung up");
    // The opposite of `create`, deliberately: a reader may already have used the
    // part that arrived, and `complete` is what stops anything mistaking it for the
    // whole file.
    expect(await store.info("abc")).toMatchObject({ size: UPLOAD_PART_BYTES, complete: false });
    expect([...(await store.read("abc", 0, 4))]).toEqual([...ramp(4)]);
  });

  test("refuses a body past its cap AS IT ARRIVES", async () => {
    const { store } = memoryStore();
    await expect(store.stream("abc", {}, body(ramp(100)), { limit: 50 })).rejects.toBeInstanceOf(
      UploadTooLargeError,
    );
  });
});

describe("a whole-file write", () => {
  /**
   * A store whose every `put` parks until the spec lets it finish.
   *
   * Local to this block rather than in `_upload-store-test-utils.ts`: it is the
   * only thing that needs to observe writes MID-FLIGHT, and a shared helper whose
   * puts do not resolve on their own is a trap for every other spec.
   */
  function gatedStore() {
    const recorder = recordingDb();
    const inner = createMemoryUploadBlobs();
    const gates: PromiseWithResolvers<void>[] = [];
    /** The offset each `put` named, in the order the puts STARTED. */
    const started: number[] = [];
    let live = 0;
    let peak = 0;
    let open = false;
    const blobs: UploadBlobs = {
      ...inner,
      put: async (key, body, options) => {
        const gate = Promise.withResolvers<void>();
        if (open) gate.resolve();
        gates.push(gate);
        started.push(Number(key.split("/").at(-1)));
        live += 1;
        peak = Math.max(peak, live);
        await gate.promise;
        const bytes = await inner.put(key, body, options);
        live -= 1;
        return bytes;
      },
    };
    return {
      store: createUploadStore({ db: recorder.db, blobs }),
      started,
      /** Let the write that started `index`th finish. */
      release: (index: number) => gates[index]?.resolve(),
      /** Let every write through, including the ones not started yet. */
      open: () => {
        open = true;
        for (const gate of gates) gate.resolve();
      },
      peak: () => peak,
    };
  }

  /**
   * `count` whole windows, cheaply.
   *
   * Zero-filled rather than `ramp`: these specs are about WHEN a window is written,
   * and building 40 MiB one byte at a time to prove that costs more than the whole
   * rest of the suite.
   */
  function windowBody(count: number): AsyncGenerator<Uint8Array> {
    return body(...Array.from({ length: count }, () => new Uint8Array(UPLOAD_PART_BYTES)));
  }

  test("keeps several windows in flight, so the uplink and the bucket overlap", async () => {
    // The property the sequential loop did not have: reading the body and writing
    // what has been read are the same wait, not two.
    const gated = gatedStore();
    const done = gated.store.create({}, windowBody(6));
    await vi.waitFor(() => expect(gated.started.length).toBe(UPLOAD_WINDOW_CONCURRENCY));
    expect(gated.started).toEqual([
      0,
      UPLOAD_PART_BYTES,
      UPLOAD_PART_BYTES * 2,
      UPLOAD_PART_BYTES * 3,
    ]);

    gated.open();
    const created = await done;
    expect(created).toMatchObject({ size: UPLOAD_PART_BYTES * 6, complete: true });
    expect(gated.peak()).toBe(UPLOAD_WINDOW_CONCURRENCY);
    // Against one as well as against the constant: a width of 1 satisfies every
    // line above that reads the constant, and is the sequential loop this replaced.
    expect(UPLOAD_WINDOW_CONCURRENCY).toBeGreaterThan(1);
  });

  test("holds no more than the window's width, however fast the body arrives", async () => {
    // The other half of the same number: a body is pulled only as slots free, so
    // peak memory is this module's choice and not the sender's.
    const gated = gatedStore();
    const done = gated.store.create({}, windowBody(5));
    await vi.waitFor(() => expect(gated.started.length).toBe(UPLOAD_WINDOW_CONCURRENCY));
    // The fifth window is not read off the wire until one of the four lands.
    expect(gated.started).toHaveLength(UPLOAD_WINDOW_CONCURRENCY);
    gated.release(0);
    await vi.waitFor(() => expect(gated.started.length).toBe(UPLOAD_WINDOW_CONCURRENCY + 1));
    for (const at of [1, 2, 3, 4]) gated.release(at);
    await expect(done).resolves.toMatchObject({ size: UPLOAD_PART_BYTES * 5 });
  });

  test("stores every window at the offset it was cut at, whatever order they land", async () => {
    // Offsets come from the CUT, not from the previous write's answer — which is
    // what makes the writes independent of each other's completion order.
    const gated = gatedStore();
    const done = gated.store.create({}, windowBody(4));
    await vi.waitFor(() => expect(gated.started.length).toBe(UPLOAD_WINDOW_CONCURRENCY));
    // Back to front, so a store deriving the next offset from the last completion
    // would place them wrong.
    for (const at of [3, 2, 1, 0]) gated.release(at);
    const created = await done;
    const read = await gated.store.read(
      created.id,
      UPLOAD_PART_BYTES * 3 - 2,
      UPLOAD_PART_BYTES * 3 + 2,
    );
    expect(read).toHaveLength(4);
    expect(created.size).toBe(UPLOAD_PART_BYTES * 4);
  });
});
