// Copyright 2026 the AAI authors. MIT license.
/**
 * The byte plumbing under every upload, stated as properties rather than cases.
 *
 * This module had **no direct test file at all** — four importers, every one of
 * them a blob backend, so the only thing exercising `chunked`/`windows`/`concat`
 * was whatever byte shapes those three backends' own specs happened to send. A
 * cut is exactly the kind of code a hand-picked fixture flatters: an offset-0,
 * whole-megabyte body agrees with almost any arithmetic.
 *
 * ## The oracles, and where each one comes from
 *
 * 1. **The INVERSE.** Whatever `chunked` cuts, joining it back yields the body;
 *    same for `windows` and for `collectCapped`. The join is written HERE, as a
 *    plain `.set()` loop, because using the subject's own `concat` to check the
 *    subject's own cut is not an oracle — a reversal in `concat` would cancel
 *    against itself.
 * 2. **`assertPartOffset`'s GRID**, which is the independent one. That function
 *    lives in `_upload-store.ts` and was written for the offsets a caller PUTs a
 *    part at; nothing about it knows `windows` exists. So its agreement with
 *    every offset a streamed cut produces is evidence rather than a restatement,
 *    and it is exactly the invariant the growing cut put at risk (see the `grow`
 *    section of {@link windows}'s doc).
 * 3. **The declared size.** Every window but the last is EXACTLY its target, and
 *    the count of windows is what the documented ramp predicts — `1, 2, 4, 8,
 *    8 … MiB` when growing, `UPLOAD_PART_BYTES` flat. `chunked` yields whole
 *    chunks and every target is a multiple of one, so a target is reached
 *    exactly rather than overshot; a cut that stopped doubling changes the COUNT
 *    even for a body small enough to have no non-final window at all.
 * 4. **The cap, at the exact byte.** A body of exactly `limit` is accepted and
 *    one byte more is refused, on all three entry points.
 *
 * ## Why the bodies are real megabytes
 *
 * `UPLOAD_CHUNK_BYTES` is not injectable, so a property about the cut has to pay
 * for it. Two things keep this in the unit tier: the source bytes are ONE
 * pattern-filled buffer allocated at module scope and handed out as
 * `subarray` views, so a run allocates nothing for its body; and the piece list
 * is CYCLED with a whole chunk appended to it, which bounds the number of pieces
 * a run generates regardless of what the generator drew (see {@link pieceSizes}).
 */

import { UPLOAD_CHUNK_BYTES, UPLOAD_PART_BYTES } from "@alexkroman1/aai/host-internal";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  chunked,
  collectCapped,
  concat,
  once,
  type PlacedWindow,
  windows,
} from "./_upload-byte-util.ts";
import { assertPartOffset, UploadTooLargeError } from "./_upload-store.ts";

/** Chunks in the largest body a property generates. Nine, so the ramp reaches its
 * fourth window (1 + 2 + 4 MiB, then a remainder) without paying for the 24 MiB a
 * fifth would cost every run. The clamped regime gets a named case below. */
const MAX_CHUNKS = 9;
const MAX_TAIL = 4096;

/**
 * The bytes every body is a window of, allocated once.
 *
 * Positional rather than random, so the comparison catches an ORDER defect and
 * not merely a length one: byte `i` is a function of `i` alone, so any
 * permutation of any two pieces is visible.
 */
const SOURCE = (() => {
  const out = new Uint8Array(MAX_CHUNKS * UPLOAD_CHUNK_BYTES + MAX_TAIL);
  for (let i = 0; i < out.length; i += 1) out[i] = (i * 7 + 13) & 0xff;
  return out;
})();

/** Join buffers the way nothing under test does — the oracle for every inverse. */
function join(parts: readonly Uint8Array[]): Uint8Array {
  const size = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Byte-for-byte, natively — a deep-equal over nine million elements is not a test. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.compare(a, b) === 0;
}

/** The body, cut into arriving pieces by a CYCLED size list. */
function pieces(total: number, sizes: readonly number[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  let at = 0;
  for (let i = 0; at < total; i += 1) {
    const size = Math.min(sizes[i % sizes.length] ?? UPLOAD_CHUNK_BYTES, total - at);
    out.push(SOURCE.subarray(at, at + size));
    at += size;
  }
  return out;
}

async function* iterate(parts: readonly Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield part;
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
}

/**
 * Piece sizes, generated as a SHORT list consumed cyclically — the rule for a
 * run whose decision count is unbounded.
 *
 * A whole chunk is APPENDED rather than the tiny draws being filtered out: a
 * list of nothing but single bytes is a legal draw that would have one run
 * generate nine million pieces, and forcing legality by appending keeps every
 * generated value mapping to a legal one, which is what shrinking needs. The
 * pool spans a byte (accumulation), a fraction of a chunk (the ordinary case),
 * and two and a half chunks (a single arrival that has to produce three).
 */
const pieceSizes = fc
  .array(
    fc.constantFrom(
      1,
      1000,
      64 * 1024,
      300 * 1024,
      UPLOAD_CHUNK_BYTES - 1,
      UPLOAD_CHUNK_BYTES,
      UPLOAD_CHUNK_BYTES + 1,
      Math.floor(2.5 * UPLOAD_CHUNK_BYTES),
    ),
    { minLength: 1, maxLength: 5 },
  )
  .map((sizes) => [...sizes, UPLOAD_CHUNK_BYTES]);

/**
 * A body length: whole chunks plus a sub-chunk tail, which is where the shapes are.
 *
 * The chunk count is WEIGHTED rather than uniform, and the reason is a floor
 * that measured zero. A FLAT cut produces more than one window only past
 * `UPLOAD_PART_BYTES`, i.e. only at eight or nine chunks, so a uniform draw
 * reached that state twice in forty and reached it not at all on one calibration
 * run in twenty — a floor that would have been a flake rather than a floor.
 */
const bodyLength = fc
  .tuple(
    fc.constantFrom(0, 1, 1, 2, 3, 4, 5, 6, 7, 8, MAX_CHUNKS, MAX_CHUNKS, MAX_CHUNKS),
    fc.integer({ min: 0, max: MAX_TAIL }),
  )
  .map(([chunks, tail]) => Math.min(chunks * UPLOAD_CHUNK_BYTES + tail, SOURCE.length));

/** How big the `n`th window of a cut may be — the documented ramp, written here. */
function windowTarget(n: number, grow: boolean): number {
  return grow ? Math.min(UPLOAD_PART_BYTES, UPLOAD_CHUNK_BYTES * 2 ** n) : UPLOAD_PART_BYTES;
}

/** How many windows a body of `total` becomes, from the same ramp. */
function windowCount(total: number, grow: boolean): number {
  let at = 0;
  let n = 0;
  while (at < total) {
    at += Math.min(windowTarget(n, grow), total - at);
    n += 1;
  }
  return n;
}

describe("chunked", () => {
  test("joining the pieces back yields the body, whatever the arrivals looked like", async () => {
    const reached = { multiChunk: 0, oneArrivalManyChunks: 0 };

    await fc.assert(
      fc.asyncProperty(bodyLength, pieceSizes, async (total, sizes) => {
        const arriving = pieces(total, sizes);
        const chunks = await collect(chunked(iterate(arriving), total));

        expect(sameBytes(join(chunks), SOURCE.subarray(0, total))).toBe(true);
        expect(chunks.length).toBe(Math.ceil(total / UPLOAD_CHUNK_BYTES));
        for (const chunk of chunks.slice(0, -1)) expect(chunk.length).toBe(UPLOAD_CHUNK_BYTES);
        const last = chunks.at(-1);
        if (last) {
          expect(last.length).toBeGreaterThan(0);
          expect(last.length).toBeLessThanOrEqual(UPLOAD_CHUNK_BYTES);
        }

        if (chunks.length > 1) reached.multiChunk += 1;
        if (arriving.some((p) => p.length > UPLOAD_CHUNK_BYTES)) reached.oneArrivalManyChunks += 1;
      }),
      { numRuns: 60 },
    );

    // Floors under the OBSERVED MINIMUM over 20 calibration runs, range in each
    // trailing comment. A "the body had a partial tail chunk" counter was
    // measured too and is deliberately NOT floored: `bodyLength` draws a
    // non-zero tail 4096 times out of 4097, so it is reached on essentially
    // every draw and carries nothing `multiChunk` does not already.
    expect(reached.multiChunk, "no body was ever cut into more than one chunk").toBeGreaterThan(30); // 49-59
    expect(
      reached.oneArrivalManyChunks,
      "no single arrival ever produced more than one chunk",
    ).toBeGreaterThan(8); // 20-36
  });

  test("the cap fires at the exact byte, and never one before it", async () => {
    const reached = { refused: 0, accepted: 0 };

    await fc.assert(
      fc.asyncProperty(
        bodyLength,
        pieceSizes,
        fc.constantFrom(-1, 0, 1, 4096),
        async (total, sizes, slack) => {
          const limit = Math.max(0, total + slack);
          const run = collect(chunked(iterate(pieces(total, sizes)), limit));
          if (total > limit) {
            await expect(run).rejects.toThrow(UploadTooLargeError);
            reached.refused += 1;
          } else {
            expect(sameBytes(join(await run), SOURCE.subarray(0, total))).toBe(true);
            reached.accepted += 1;
          }
        },
      ),
      { numRuns: 40 },
    );

    // 20 calibration runs. Both arms have to be reached or the property is half a
    // property: `slack: -1` is the only refusing draw and `total: 0` neutralizes
    // it, so the refusing arm is the rarer of the two.
    expect(reached.refused, "no body was ever over its limit").toBeGreaterThan(2); // 4-15
    expect(reached.accepted, "no body was ever inside its limit").toBeGreaterThan(20); // 25-36
  });
});

describe("concat", () => {
  test("joins in order, and hands back the single right-sized part unchanged", () => {
    const reached = { fastPath: 0, copied: 0 };

    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 3 * 4096 }), { minLength: 1, maxLength: 6 }),
        (sizes) => {
          const parts: Uint8Array[] = [];
          let at = 0;
          for (const size of sizes) {
            parts.push(SOURCE.subarray(at, at + size));
            at += size;
          }
          const size = at;
          const joined = concat(parts, size);

          expect(sameBytes(joined, SOURCE.subarray(0, size))).toBe(true);
          if (parts.length === 1 && parts[0]?.length === size) {
            // The documented skip: the ordinary case is one whole chunk, and
            // copying it is the copy this exists to avoid.
            expect(joined).toBe(parts[0]);
            reached.fastPath += 1;
          } else {
            reached.copied += 1;
          }
        },
      ),
      { numRuns: 200 },
    );

    // 20 calibration runs. The fast path is one draw in six-odd, so its floor is
    // the one that matters — a `concat` that stopped taking it would still pass
    // every byte comparison above.
    expect(reached.fastPath, "the single-part fast path was never taken").toBeGreaterThan(12); // 27-45
    expect(reached.copied, "every draw took the fast path").toBeGreaterThan(120); // 155-173
  });
});

describe("windows", () => {
  test("every offset is on the grid a PART upload is held to", async () => {
    const reached = { rampDoubled: 0, flatMultiWindow: 0 };

    await fc.assert(
      fc.asyncProperty(bodyLength, pieceSizes, fc.boolean(), async (total, sizes, grow) => {
        const cut = await collect<PlacedWindow>(
          windows(iterate(pieces(total, sizes)), total, grow),
        );

        // The independent oracle: `assertPartOffset` belongs to the parts path
        // and knows nothing about this cut.
        for (const window of cut) expect(() => assertPartOffset(window.at)).not.toThrow();

        // Contiguous, from zero, covering the body exactly.
        let at = 0;
        for (const window of cut) {
          expect(window.at).toBe(at);
          at += window.bytes.length;
        }
        expect(at).toBe(total);
        expect(sameBytes(join(cut.map((w) => w.bytes)), SOURCE.subarray(0, total))).toBe(true);

        // The declared size, and the count the documented ramp predicts — which
        // is what catches a cut that stopped doubling even when the body is too
        // small to have a non-final window at all.
        expect(cut.length).toBe(windowCount(total, grow));
        cut.forEach((window, index) => {
          const target = windowTarget(index, grow);
          if (index < cut.length - 1) expect(window.bytes.length).toBe(target);
          else expect(window.bytes.length).toBeLessThanOrEqual(target);
        });

        if (grow && cut[1]?.bytes.length === 2 * UPLOAD_CHUNK_BYTES) reached.rampDoubled += 1;
        if (!grow && cut.length > 1) reached.flatMultiWindow += 1;
      }),
      { numRuns: 120 },
    );

    // 20 calibration runs. A "grow produced more than one window" counter was
    // measured and dropped: `rampDoubled` cannot be reached without it, so the
    // second floor would carry the first one's information.
    expect(reached.rampDoubled, "the growing cut never actually doubled").toBeGreaterThan(15); // 33-53
    expect(
      reached.flatMultiWindow,
      "the flat cut never produced more than one window",
    ).toBeGreaterThan(5); // 12-24
  });

  test("an empty body is no windows at all", async () => {
    // Not a draw: `bodyLength` reaches zero only when both of its components do,
    // which is too rare to floor — so the case is named instead of counted.
    expect(await collect(windows(iterate([]), 0, true))).toEqual([]);
    expect(await collect(windows(iterate([]), 0, false))).toEqual([]);
  });

  test("the ramp CLAMPS at one part, and the clamped offsets stay on the grid", async () => {
    // Deliberately a named case rather than a draw: the clamp binds only once a
    // FIFTH window exists (1 + 2 + 4 + 8 MiB, then more), so reaching it in the
    // property above would put a 24 MiB body and its copies in every run.
    const total = 3 * UPLOAD_PART_BYTES;
    const body = new Uint8Array(total);
    for (let i = 0; i < total; i += 1) body[i] = (i * 11 + 3) & 0xff;

    const cut = await collect<PlacedWindow>(windows(iterate([body]), total, true));

    expect(cut.map((w) => w.bytes.length)).toEqual([
      UPLOAD_CHUNK_BYTES,
      2 * UPLOAD_CHUNK_BYTES,
      4 * UPLOAD_CHUNK_BYTES,
      UPLOAD_PART_BYTES,
      UPLOAD_PART_BYTES,
      UPLOAD_PART_BYTES - 7 * UPLOAD_CHUNK_BYTES,
    ]);
    for (const window of cut) expect(() => assertPartOffset(window.at)).not.toThrow();
    expect(sameBytes(join(cut.map((w) => w.bytes)), body)).toBe(true);
  });

  test("a body that DIES still yields the window it was filling", async () => {
    // The bytes are already here, and on the streamed path a reader was promised
    // them — see the `grow` section of {@link windows}'s doc. Named rather than
    // drawn because it is the boundary that matters: the ramp's fourth target is
    // 8 MiB, so a body of exactly 7 + 1 chunks is holding one whole megabyte
    // against it when the failure arrives, which is the megabyte that used to go
    // out with the error.
    const total = 8 * UPLOAD_CHUNK_BYTES;
    async function* dies(): AsyncGenerator<Uint8Array> {
      for (const piece of pieces(total, [UPLOAD_CHUNK_BYTES])) yield piece;
      throw new Error("client hung up");
    }
    const cut: PlacedWindow[] = [];
    await expect(
      (async () => {
        for await (const window of windows(dies(), total, true)) cut.push(window);
      })(),
    ).rejects.toThrow("client hung up");

    // 1 + 2 + 4 MiB on the ramp, then the megabyte it was holding.
    expect(cut.map((w) => w.bytes.length)).toEqual([
      UPLOAD_CHUNK_BYTES,
      2 * UPLOAD_CHUNK_BYTES,
      4 * UPLOAD_CHUNK_BYTES,
      UPLOAD_CHUNK_BYTES,
    ]);
    // Still contiguous from zero, still on the grid, still the bytes that arrived.
    for (const window of cut) expect(() => assertPartOffset(window.at)).not.toThrow();
    expect(sameBytes(join(cut.map((w) => w.bytes)), SOURCE.subarray(0, total))).toBe(true);
  });

  test("a sub-chunk remainder is what a dying body really does lose", async () => {
    // The other half of the rule above, and the reason the flush stays whole
    // megabytes: `chunked` holds its own partial piece and loses it on the same
    // failure, so nothing off the grid ever reaches the cut.
    async function* dies(): AsyncGenerator<Uint8Array> {
      yield SOURCE.subarray(0, UPLOAD_CHUNK_BYTES);
      yield SOURCE.subarray(UPLOAD_CHUNK_BYTES, UPLOAD_CHUNK_BYTES + 1000);
      throw new Error("client hung up");
    }
    const cut: PlacedWindow[] = [];
    await expect(
      (async () => {
        for await (const window of windows(dies(), 4 * UPLOAD_CHUNK_BYTES, true)) cut.push(window);
      })(),
    ).rejects.toThrow("client hung up");
    expect(cut.map((w) => [w.at, w.bytes.length])).toEqual([[0, UPLOAD_CHUNK_BYTES]]);
  });

  test("refuses past the limit, like the cut underneath it", async () => {
    const total = 2 * UPLOAD_CHUNK_BYTES;
    const run = collect(windows(iterate(pieces(total, [UPLOAD_CHUNK_BYTES])), total - 1, true));
    await expect(run).rejects.toThrow(UploadTooLargeError);
  });
});

describe("collectCapped", () => {
  test("drains a body whole, and refuses one byte past the cap", async () => {
    const reached = { refused: 0, uncapped: 0 };

    await fc.assert(
      fc.asyncProperty(
        bodyLength,
        pieceSizes,
        fc.constantFrom<number | undefined>(undefined, -1, 0),
        async (total, sizes, slack) => {
          const limit = slack === undefined ? undefined : Math.max(0, total + slack);
          const run = collectCapped(iterate(pieces(total, sizes)), limit);
          if (limit !== undefined && total > limit) {
            await expect(run).rejects.toThrow(UploadTooLargeError);
            reached.refused += 1;
          } else {
            expect(sameBytes(await run, SOURCE.subarray(0, total))).toBe(true);
            if (limit === undefined) reached.uncapped += 1;
          }
        },
      ),
      { numRuns: 40 },
    );

    // 20 calibration runs. The uncapped arm is the one an `undefined` limit is
    // for — a blob backend with no agent cap configured — and it is a third of
    // the draws.
    expect(reached.refused, "no body was ever over its cap").toBeGreaterThan(2); // 6-19
    expect(reached.uncapped, "no body was ever drained without a cap").toBeGreaterThan(4); // 10-20
  });
});

describe("once", () => {
  test("hands one value over and stops", async () => {
    const value = SOURCE.subarray(0, 17);
    expect(await collect(once(value))).toEqual([value]);
  });
});
