// Copyright 2026 the AAI authors. MIT license.
/**
 * How a file is CUT, and whether the bytes a part NAMES are the bytes it holds.
 *
 * The interesting line in this module is one addition:
 *
 * ```ts no-check
 * if (ArrayBuffer.isView(file)) {
 *   return new Uint8Array(file.buffer, file.byteOffset + start, end - start);
 * }
 * ```
 *
 * A view does not own its buffer, so a window of it starts at the VIEW's offset
 * plus the window's — and a fixture built from `new Uint8Array(n)` has a
 * `byteOffset` of zero, which makes `byteOffset + start` and `start`
 * indistinguishable. That is the whole reason the bodies here are generated at
 * non-zero offsets, and the reason a `Uint16Array` and a `DataView` are in the
 * pool: `sliceableBytes` measures a view in BYTES (`byteLength`), so an
 * element-width confusion is a second way to name the wrong bytes.
 *
 * The `ArrayBuffer` arm answers a view too now, where it used to `.slice()` —
 * so the claim there is IDENTITY rather than content, and it needs a case of its
 * own: a copy has exactly the right bytes, which is what makes the property
 * above blind to it.
 *
 * ## Two properties, two classes
 *
 * - **`sliceOf` is VALUE-LEVEL** — one body, one window, one round trip. It
 *   carries no coverage floor and none would mean anything: every draw exercises
 *   the same single claim, and the remedy for a gap is another claim rather than
 *   a counter (`AGENTS.md`, "Property tests run on fast-check").
 * - **`partsPlan` WALKS the branch structure** — decline, one-part resumable
 *   re-cut, ordinary fan-out — so it counts which of the three it reached and
 *   floors each. A generator that stopped producing multi-part plans would
 *   otherwise pass, faster, forever.
 *
 * The oracle for both is the same and is not a restatement of the arithmetic: a
 * plan TILES the body (contiguous from zero, each start on the
 * `UPLOAD_CHUNK_BYTES` grid, indices in order, last part ending at the total),
 * and joining the bytes each part names reproduces the body. What the cut
 * ARITHMETIC is stays `planParts`'s business.
 */

import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { partsPlan, planParts, sliceOf } from "./_upload-parts-plan.ts";
import { UPLOAD_CHUNK_BYTES, UPLOAD_PART_BYTES } from "./upload-constants.ts";
import type { UploadBody } from "./workflow-upload-client.ts";

/** Chunks in the largest generated body — nine, so a 1 MiB cut fans out nine ways. */
const MAX_CHUNKS = 9;

/**
 * The bytes every body is a view of, allocated once.
 *
 * Positional, so a window naming the wrong bytes is visible rather than merely
 * the wrong LENGTH: byte `i` is a function of `i`, so an offset that is off by
 * three reads as three wrong bytes and not as a short buffer.
 */
const SOURCE = (() => {
  const out = new Uint8Array(MAX_CHUNKS * UPLOAD_CHUNK_BYTES + 4096 + 64);
  for (let i = 0; i < out.length; i += 1) out[i] = (i * 7 + 13) & 0xff;
  return out;
})();

/** The bytes a body logically holds — a view's own window, not its buffer's. */
function bytesOf(body: UploadBody): Uint8Array {
  if (typeof body === "string") throw new TypeError("a string body has no bytes to compare");
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  // Narrowed with `isView` rather than `instanceof Blob`, matching what the
  // module under test does and for the same reason: a `File` from another realm
  // fails an instance check.
  if (!ArrayBuffer.isView(body)) throw new TypeError("a Blob's bytes are read asynchronously");
  return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.compare(a, b) === 0;
}

/** Join the windows a plan names, without going near the module under test. */
function join(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Every spelling of "a body with bytes", the views at a NON-ZERO offset. */
const BODY_SHAPES = ["arraybuffer", "uint8", "uint16", "dataview"] as const;

/**
 * A body of `length` bytes starting `offset` into {@link SOURCE}.
 *
 * `offset` is rounded up to the shape's element width rather than being drawn
 * per shape: a `Uint16Array` refuses an odd `byteOffset`, and generating an
 * illegal one to then discard it would break the generator's own contract.
 */
function makeBody(shape: (typeof BODY_SHAPES)[number], offset: number, length: number): UploadBody {
  if (shape === "arraybuffer") return SOURCE.buffer.slice(offset, offset + length);
  if (shape === "uint8") return SOURCE.subarray(offset, offset + length);
  if (shape === "dataview") return new DataView(SOURCE.buffer, offset, length);
  const width = 2;
  const aligned = Math.ceil(offset / width) * width;
  return new Uint16Array(SOURCE.buffer, aligned, Math.floor(length / width));
}

describe("sliceOf", () => {
  test("names the bytes it holds, whatever the body is a view of", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...BODY_SHAPES),
        fc.integer({ min: 0, max: 8 }),
        fc.integer({ min: 0, max: 48 }),
        fc.integer({ min: 0, max: 48 }),
        fc.integer({ min: 0, max: 48 }),
        (shape, offset, length, a, b) => {
          const file = makeBody(shape, offset, length);
          const whole = bytesOf(file);
          // A window inside the body, ordered by construction rather than by a
          // filter — a discarded draw is a draw the shrinker cannot walk.
          const start = Math.min(a, b, whole.length);
          const end = Math.min(Math.max(a, b), whole.length);

          const window = bytesOf(sliceOf(file, start, end));
          expect(window.length).toBe(end - start);
          expect(sameBytes(window, whole.subarray(start, end))).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  test("an ArrayBuffer window is a VIEW over the caller's buffer, not a copy", () => {
    // `ArrayBuffer.prototype.slice` copies where the `isView` arm does not, and
    // the copy bought nothing: the caller holds the whole body for the length of
    // the upload either way, so a window aliasing it retains nothing that was not
    // already retained. Asserted on IDENTITY, because a copy has the right bytes.
    const file = SOURCE.buffer.slice(0, 64);
    const window = sliceOf(file, 7, 21);

    expect(ArrayBuffer.isView(window)).toBe(true);
    expect((window as Uint8Array).buffer).toBe(file);
    expect((window as Uint8Array).byteOffset).toBe(7);
    // And it still names the right bytes, which identity alone does not say.
    expect(sameBytes(bytesOf(window), new Uint8Array(file, 7, 14))).toBe(true);
  });

  test("a Blob is sliced by delegation, offsets and all", async () => {
    // Async, so it is a case rather than a draw: the point is only that the
    // Blob arm forwards, which has no arithmetic to get wrong.
    const blob = new Blob([SOURCE.subarray(0, 40)]);
    const sliced = sliceOf(blob, 7, 21) as Blob;
    expect(sliced.size).toBe(14);
    const bytes = new Uint8Array(await sliced.arrayBuffer());
    expect(sameBytes(bytes, SOURCE.subarray(7, 21))).toBe(true);
  });
});

describe("partsPlan", () => {
  test("a plan TILES the body, and every part names the bytes it covers", () => {
    const reached = { declined: 0, singlePartRecut: 0, fannedOut: 0, viewAtOffset: 0 };

    fc.assert(
      fc.property(
        fc.constantFrom(...BODY_SHAPES.filter((s) => s !== "arraybuffer")),
        fc.integer({ min: 0, max: 8 }),
        // WEIGHTED, not uniform: the resumable one-part re-cut is reachable
        // only under one chunk, and a uniform draw over nine reached it once in
        // one calibration run of twenty — a floor that would have been a flake.
        fc.constantFrom(0, 0, 1, 1, 2, 3, 5, 8, MAX_CHUNKS, MAX_CHUNKS),
        fc.integer({ min: 0, max: 4096 }),
        fc.constantFrom<number | undefined>(
          undefined,
          1,
          UPLOAD_CHUNK_BYTES,
          UPLOAD_CHUNK_BYTES + 1,
          3 * UPLOAD_CHUNK_BYTES,
          UPLOAD_PART_BYTES,
        ),
        fc.boolean(),
        (shape, offset, chunks, tail, partBytes, resumable) => {
          const length = chunks * UPLOAD_CHUNK_BYTES + tail;
          const file = makeBody(shape, offset, length);
          const whole = bytesOf(file);
          const plan = partsPlan(file, { partBytes }, { resumable });

          if (plan === undefined) {
            // The two documented declines: nothing to send, or one part on a
            // path whose only prize is speed.
            expect(whole.length === 0 || resumable === false).toBe(true);
            reached.declined += 1;
            return;
          }

          // A non-empty sliceable body is NEVER declined when it has to be
          // resumable — the rule the module doc leads with.
          expect(plan.total).toBe(whole.length);
          expect(plan.parts.length).toBeGreaterThan(0);

          let at = 0;
          plan.parts.forEach((part, index) => {
            expect(part.index).toBe(index);
            expect(part.start).toBe(at);
            expect(part.start % UPLOAD_CHUNK_BYTES).toBe(0);
            expect(part.end).toBeGreaterThan(part.start);
            at = part.end;
          });
          expect(at).toBe(plan.total);

          const named = plan.parts.map((p) => bytesOf(sliceOf(file, p.start, p.end)));
          expect(sameBytes(join(named), whole)).toBe(true);

          const sizes = plan.parts.map((p) => p.end - p.start);
          for (const size of sizes.slice(0, -1)) expect(size).toBe(sizes[0]);

          if (plan.parts.length === 1) {
            // The granularity half: a one-part plan exists only for a resumable
            // upload, and only because the re-cut at the chunk grid found
            // nothing finer to cut — so it is at most one chunk.
            expect(resumable).toBe(true);
            expect(plan.total).toBeLessThanOrEqual(UPLOAD_CHUNK_BYTES);
            reached.singlePartRecut += 1;
          } else {
            reached.fannedOut += 1;
          }
          // The state the `byteOffset + start` addition exists for: a body
          // whose bytes do not start at its buffer's byte zero.
          if (ArrayBuffer.isView(file) && file.byteOffset > 0) reached.viewAtOffset += 1;
        },
      ),
      { numRuns: 200 },
    );

    // Floors under the OBSERVED MINIMUM over 20 calibration runs, range in each
    // trailing comment. All three branches have to be reached: the decline is
    // the default for a small file, the re-cut is the bug the `resumable` flag
    // was added for, and the fan-out is the path itself.
    expect(reached.declined, "no draw was ever declined").toBeGreaterThan(20); // 34-58
    expect(
      reached.singlePartRecut,
      "the resumable one-part re-cut was never reached",
    ).toBeGreaterThan(8); // 15-30
    expect(reached.fannedOut, "no plan ever had more than one part").toBeGreaterThan(90); // 119-144
    expect(reached.viewAtOffset, "every planned body was a view at offset zero").toBeGreaterThan(
      90,
    ); // 124-148
  });

  test("a string body declines, because measuring it means encoding it twice", () => {
    expect(partsPlan("hello", {}, { resumable: true })).toBeUndefined();
    expect(partsPlan("hello", {})).toBeUndefined();
  });

  test("an empty body declines either way: nothing to send, nothing to resume", () => {
    expect(partsPlan(new Uint8Array(0), {}, { resumable: true })).toBeUndefined();
    expect(partsPlan(new ArrayBuffer(0), {}, { resumable: true })).toBeUndefined();
  });
});

describe("planParts", () => {
  test("a caller's preference is rounded UP to the next whole chunk, never down", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: MAX_CHUNKS * UPLOAD_CHUNK_BYTES }),
        fc.integer({ min: -10, max: 3 * UPLOAD_CHUNK_BYTES }),
        (total, partBytes) => {
          const parts = planParts(total, partBytes);
          if (total === 0) {
            expect(parts).toEqual([]);
            return;
          }

          let at = 0;
          for (const part of parts) {
            expect(part.start).toBe(at);
            expect(part.start % UPLOAD_CHUNK_BYTES).toBe(0);
            at = part.end;
          }
          expect(at).toBe(total);

          // Characterised by two inequalities rather than by the expression:
          // a FULL part is the SMALLEST multiple of a chunk that is at least
          // the preference and at least one chunk. A rounding that went down,
          // or one that overshot by a whole extra chunk, breaks one of them.
          // Only a plan with a second part HAS a full part to read this off;
          // one part is a truncated one, so the claim there is the weaker
          // upper bound.
          const asked = Math.max(partBytes, UPLOAD_CHUNK_BYTES);
          const sizes = parts.map((p) => p.end - p.start);
          if (sizes.length > 1) {
            const full = sizes[0] ?? 0;
            expect(full % UPLOAD_CHUNK_BYTES).toBe(0);
            expect(full).toBeGreaterThanOrEqual(asked);
            expect(full - asked).toBeLessThan(UPLOAD_CHUNK_BYTES);
            for (const size of sizes.slice(0, -1)) expect(size).toBe(full);
            expect(sizes.at(-1)).toBeLessThanOrEqual(full);
          } else {
            expect(sizes[0]).toBe(total);
            expect(total).toBeLessThanOrEqual(
              Math.ceil(asked / UPLOAD_CHUNK_BYTES) * UPLOAD_CHUNK_BYTES,
            );
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
