// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the byte contract the store writes through, and for the two derivations
 * that turn a boundary list back into an answer.
 *
 * These carry what the deleted file backend's suite carried, and for the same reason
 * it was driven for real: the whole subject is byte offsets, which a fake would only
 * restate. What changed is which seam that argument applies to — `UploadBlobs` is a
 * window read and a length, so the memory implementation is equivalent to a bucket by
 * construction, where the file backend was a second STORE and had to be kept in step
 * with a record contract it shared.
 */

import { describe, expect, test } from "vitest";
import {
  createMemoryUploadBlobs,
  partKey,
  partsCovering,
  partsOf,
  rangesOf,
  type UploadPart,
} from "./_upload-blobs.ts";
import { UploadTooLargeError } from "./_upload-store.ts";
import { ramp } from "./_upload-store-test-utils.ts";

async function* once(value: Uint8Array): AsyncGenerator<Uint8Array> {
  yield value;
}

describe("the memory implementation", () => {
  test("stores an object and reads back the window it is asked for", async () => {
    const blobs = createMemoryUploadBlobs();
    expect(await blobs.put("a/1/0", once(ramp(1000)))).toBe(1000);
    expect([...(await blobs.read("a/1/0", 10, 15))]).toEqual([...ramp(5, 10)]);
    expect(await blobs.size("a/1/0")).toBe(1000);
  });

  test("counts what ARRIVES, not what a header declared", async () => {
    const blobs = createMemoryUploadBlobs();
    expect(await blobs.put("a/1/0", body(ramp(4), ramp(6, 4)))).toBe(10);
    expect([...(await blobs.read("a/1/0", 0, 10))]).toEqual([...ramp(10)]);
  });

  test("refuses a body past its limit AS IT ARRIVES", async () => {
    const blobs = createMemoryUploadBlobs();
    await expect(blobs.put("a/1/0", body(ramp(40), ramp(40, 40)), { limit: 50 })).rejects.toThrow(
      UploadTooLargeError,
    );
  });

  test("REPLACES on a repeat, because a part is retried", async () => {
    // The ordinary failure the parts path exists to survive is a connection dying
    // mid-flight, so a repeat has to be the same object rather than a second one —
    // which the offset in the key makes true by construction.
    const blobs = createMemoryUploadBlobs();
    await blobs.put("a/1/0", once(ramp(10)));
    await blobs.put("a/1/0", once(ramp(10)));
    expect(await blobs.size("a/1/0")).toBe(10);
  });

  test("answers SHORT rather than throwing when there is less than was asked for", async () => {
    // The clamp `readUpload` has always applied: a plan computed from a header is
    // allowed to end one byte past the file.
    const blobs = createMemoryUploadBlobs();
    await blobs.put("a/1/0", once(ramp(10)));
    expect([...(await blobs.read("a/1/0", 8, 100))]).toEqual([...ramp(2, 8)]);
    expect([...(await blobs.read("a/1/0", 50, 60))]).toEqual([]);
  });

  test("answers undefined for a key nothing was written to", async () => {
    // The whole defence against a claimed part that is not there: `size` never
    // over-reports, so a hole cannot be recorded as a readable byte.
    const blobs = createMemoryUploadBlobs();
    expect(await blobs.size("a/1/0")).toBeUndefined();
    expect([...(await blobs.read("a/1/0", 0, 10))]).toEqual([]);
  });
});

describe("the objects a window overlaps", () => {
  const parts: UploadPart[] = [
    { at: 0, bytes: 10 },
    { at: 10, bytes: 10 },
    { at: 30, bytes: 10 },
  ];

  test("names one object for a window inside one, which is the ordinary case", () => {
    expect(partsCovering(parts, 2, 8)).toEqual([{ part: parts[0], from: 2, to: 8 }]);
  });

  test("names both, in read ORDER, for a window that spans a boundary", () => {
    // Order is load-bearing rather than cosmetic: parts land in whatever order the
    // network settles, so returning them as stored would reassemble a file whose
    // windows are correct and whose bytes are shuffled.
    expect(partsCovering([...parts].toReversed(), 8, 12)).toEqual([
      { part: parts[0], from: 8, to: 10 },
      { part: parts[1], from: 0, to: 2 },
    ]);
  });

  test("skips a GAP rather than reading past it", () => {
    expect(partsCovering(parts, 20, 30)).toEqual([]);
  });
});

describe("the windows a part list covers", () => {
  test("joins parts that TOUCH, so a contiguous file is one range", () => {
    // Two parts meeting exactly on a boundary is the ordinary case, and joining them
    // is what makes the contiguous prefix a single lookup.
    expect(
      rangesOf([
        { at: 0, bytes: 10 },
        { at: 10, bytes: 10 },
      ]),
    ).toEqual([{ start: 0, end: 20 }]);
  });

  test("keeps a gap a gap, whatever order the parts landed in", () => {
    expect(
      rangesOf([
        { at: 20, bytes: 10 },
        { at: 0, bytes: 10 },
      ]),
    ).toEqual([
      { start: 0, end: 10 },
      { start: 20, end: 30 },
    ]);
  });

  test("covers nothing for no parts", () => {
    expect(rangesOf([])).toEqual([]);
  });
});

describe("reading a stored boundary list", () => {
  test("parses the `::text` STRING the driver really hands back", () => {
    // The bug this function exists for: the store trusted postgres.js to parse its
    // `jsonb` column, on a comment asserting it does. It does not — `parts.filter` was
    // not a function, so every parts upload, range read and `info` threw against a real
    // database while 4,410 unit tests passed, because the fake agreed with the comment.
    expect(partsOf('[{"at":0,"bytes":8}]')).toEqual([{ at: 0, bytes: 8 }]);
  });

  test("accepts an already-parsed array, so the store never has to ask which", () => {
    expect(partsOf([{ at: 8, bytes: 8 }])).toEqual([{ at: 8, bytes: 8 }]);
  });

  test("answers EMPTY for null, nonsense, and a column that is not a list", () => {
    // A fresh row's column is null; anything else here is a column nothing wrote.
    expect(partsOf(null)).toEqual([]);
    expect(partsOf(undefined)).toEqual([]);
    expect(partsOf("not json")).toEqual([]);
    expect(partsOf('{"at":0}')).toEqual([]);
  });

  test("DROPS an entry that is not two byte counts", () => {
    // The row is in the TENANT's own database on the tenant's own role, so this column
    // is a value they can write anything into. A `NaN` offset would make
    // `contiguousBytes` answer nonsense and a negative one would have a read ask for a
    // window before the file starts.
    expect(
      partsOf([
        { at: 0, bytes: 8 },
        { at: "4", bytes: 8 },
        { at: Number.NaN, bytes: 8 },
        { at: -8, bytes: 8 },
        { at: 8, bytes: -1 },
        { at: 16 },
        null,
        16,
      ]),
    ).toEqual([{ at: 0, bytes: 8 }]);
  });
});

describe("a part's key", () => {
  test("is the prefix, the upload, and the byte it starts at", () => {
    // The offset IS the name, which is what makes a retry idempotent and what the
    // brokered implementation slices the last two segments off.
    expect(partKey("uploads", "upl_a", 8_388_608)).toBe("uploads/upl_a/8388608");
  });
});

/** One body from several pieces, as a route hands it over. */
async function* body(...pieces: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const piece of pieces) yield piece;
}
