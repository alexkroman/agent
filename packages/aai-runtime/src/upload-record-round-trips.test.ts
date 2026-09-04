// Copyright 2026 the AAI authors. MIT license.
/**
 * How many times one upload operation resolves the RECORD.
 *
 * Not a behaviour spec — every other upload suite covers what the store answers.
 * This one counts, because on a deployed guest a record look-up is one
 * `POST /:slug/upload-records` across the platform and into the admin pool, and
 * nothing else in the tree can see that number. Measured over 48 hours of
 * production, that route was the second-largest by count (n=1428, mean 537 ms) and
 * within one 33-segment transcription it outnumbered the journal 515 to 212 — for
 * a run that moved 140 part windows, i.e. **3.7 record calls per window**.
 *
 * The decomposition it found, and which of those calls are load-bearing:
 *
 * | operation | calls | why |
 * | --- | --- | --- |
 * | `beginParts` | 1 | the claim itself |
 * | `recordParts` (one claim) | **2** | a read the refusals need, then the write |
 * | `stepUploadInfo` (one poll) | 1 | the poll IS a read |
 * | `stepReadUpload` (one window) | **1**, was 2 | see below |
 * | `GET /uploads/:id` (N chunks) | **1**, was N+1 | see below |
 *
 * The two that moved were the same defect: {@link UploadReader.info} and
 * {@link UploadReader.read} each resolve the record for themselves, and every
 * reader needs both — so a `stepReadUpload` looked the row up twice and the byte route
 * looked it up once per `UPLOAD_CHUNK_BYTES` of the answer. `UploadReader.open`
 * hands back the record AND a reader bound to it, which is one look-up per logical
 * read and pins the window map for its duration.
 *
 * **The claim's two are both load-bearing, and this file is where that is
 * recorded so the next reader does not re-derive it.** Its read is not the
 * write's merge base alone: `recordParts` validates every named window against
 * `expected` — the DECLARED total, which only the record carries — and decides the
 * finished-upload refusal (a re-sent claim naming only recorded windows is a no-op,
 * anything else is a 409) before it writes anything. Collapsing them means moving
 * those refusals into the record's HOME, which is three homes and three error
 * vocabularies (`aai-server`'s SQL handler among them) to save one round trip.
 */

import { publishUploadReader, UPLOAD_PART_BYTES } from "@alexkroman1/aai/host-internal";
import { stepReadUpload, stepUploadInfo } from "@alexkroman1/aai/step";
import { afterEach, expect, test } from "vitest";
import { partKey } from "./_upload-blobs.ts";
import type { UploadRecord, UploadRecords } from "./_upload-records.ts";
import { createBlobUploadStore } from "./_upload-store-blobs.ts";
import { createMemoryUploadBackend } from "./workflow-uploads.ts";

/** Where this deployment's objects live — arbitrary, and the same on both sides. */
const PREFIX = "uploads/agent";

/**
 * A record home that COUNTS, over a `Map`.
 *
 * Deliberately not `recordingDb` from `_upload-store-test-utils.ts`: that one
 * records SQL statements, which is a fact about the Postgres arm, where what is
 * counted here is calls to the seam — the thing a platform deployment pays a round
 * trip for whichever home is behind it.
 */
function countingRecords(): { records: UploadRecords; calls: () => number } {
  const rows = new Map<string, UploadRecord>();
  let calls = 0;
  return {
    calls: () => calls,
    records: {
      // Local on the platform arm, so it is NOT counted — see
      // `uploads-platform.ts`, "`ensure` is local".
      ensure: () => Promise.resolve(),
      read(id) {
        calls += 1;
        const held = rows.get(id);
        // Copied out, so a caller mutating what it read cannot reach the row and
        // make a missing write look like a successful one.
        return Promise.resolve(held ? { ...held, parts: [...held.parts] } : undefined);
      },
      claim(id, record) {
        calls += 1;
        rows.set(id, { ...record, parts: [...record.parts] });
        return Promise.resolve();
      },
      insert(id, record) {
        calls += 1;
        rows.set(id, { ...record, parts: [...record.parts] });
        return Promise.resolve();
      },
      update(id, state) {
        calls += 1;
        const held = rows.get(id);
        if (held) rows.set(id, { ...held, ...state, parts: [...state.parts] });
        return Promise.resolve();
      },
      finish(id, size) {
        calls += 1;
        const held = rows.get(id);
        if (held) rows.set(id, { ...held, size, complete: true });
        return Promise.resolve();
      },
    },
  };
}

afterEach(() => publishUploadReader(undefined));

test("one parts upload costs a countable number of record round trips", async () => {
  const { records, calls } = countingRecords();
  const blobs = createMemoryUploadBackend();
  const store = createBlobUploadStore({ records, blobs, prefix: PREFIX, maxBytes: 1e12 });
  publishUploadReader(store);
  const id = "upl_counted";
  const windows = 4;

  const begin = calls();
  await store.beginParts(id, {}, windows * UPLOAD_PART_BYTES);
  expect(calls() - begin).toBe(1);

  // The DIRECT path: the browser put each window in the bucket itself and the claim
  // carries no bytes at all. One claim per window is what production really does —
  // `createClaimer` coalesces, and a claim costs about what a window's bytes cost,
  // so at the measured rate almost every claim named exactly one offset.
  for (let n = 0; n < windows; n++) {
    const at = n * UPLOAD_PART_BYTES;
    await blobs.put(
      partKey(PREFIX, id, at),
      (async function* () {
        yield new Uint8Array(UPLOAD_PART_BYTES);
      })(),
    );
    const before = calls();
    await store.recordParts(id, [at]);
    // Two, and both are defended in the module doc above. Lower it only by moving
    // the refusals, never by trusting a cached `parts` — the read-modify-write is
    // sound because ONE process writes this row, and a process-local copy of it
    // outlives the lock that makes the claim true.
    expect(calls() - before).toBe(2);
  }

  const poll = calls();
  await stepUploadInfo(id);
  expect(calls() - poll).toBe(1);

  // ONE, where it used to be two: `stepReadUpload` resolved the record for its clamp and
  // then again for its bytes. The window spans two objects, so this also pins that
  // the count is per READ rather than per object touched.
  const read = calls();
  const slice = await stepReadUpload(id, {
    start: UPLOAD_PART_BYTES - 1,
    end: UPLOAD_PART_BYTES * 2,
  });
  expect(slice.bytes).toHaveLength(UPLOAD_PART_BYTES + 1);
  expect(calls() - read).toBe(1);
});

test("a reader with no `open` still resolves through info and read", async () => {
  // The fallback that keeps every two-method fake — `stubUploads`, and whatever a
  // user wrote against the published `UploadReader` — working unchanged. It is the
  // pre-`open` path exactly, which is why it may cost two look-ups: an in-memory
  // fake pays nothing for one.
  let lookups = 0;
  publishUploadReader({
    info: (id) => {
      lookups += 1;
      return Promise.resolve({ id, name: "", type: "", size: 4, complete: true });
    },
    read: (_id, start, end) => {
      lookups += 1;
      return Promise.resolve(new Uint8Array([1, 2, 3, 4]).subarray(start, end));
    },
  });
  const slice = await stepReadUpload("upl_fake", { start: 1, end: 3 });
  expect([...slice.bytes]).toEqual([2, 3]);
  expect(lookups).toBe(2);
});
