// Copyright 2026 the AAI authors. MIT license.
/**
 * `readEventStream` is fed by a network, and a network chooses where a chunk
 * ends: inside a multi-byte UTF-8 character, between the `\r` and `\n` of a
 * CRLF, or between the two `\n` that close a frame. So the properties here are
 * about INDEPENDENCE from that choice — the same bytes, split anywhere, read as
 * the same frames — and about garbage never tearing the reader down.
 *
 * CR-only line endings are left out on purpose: the module documents that a
 * trailing lone `\r` is held back, so that stream dispatches one frame late.
 */
import fc from "fast-check";
import { describe, expect, test } from "vitest";

import { type EventStreamFrame, readEventStream } from "./event-stream.ts";

/** Offsets in `0..bytes.length` that `cuts` name, deduplicated and ascending. */
function cutPoints(bytes: Uint8Array, cuts: readonly number[]): number[] {
  return [...new Set(cuts.map((c) => c % (bytes.length + 1)))].sort((a, b) => a - b);
}

/** A byte stream that delivers `bytes` cut at `cuts` (offsets, any order, repeats allowed). */
function streamOf(bytes: Uint8Array, cuts: readonly number[]): ReadableStream<Uint8Array> {
  const points = cutPoints(bytes, cuts);
  const chunks: Uint8Array[] = [];
  let from = 0;
  for (const to of [...points, bytes.length]) {
    if (to > from) chunks.push(bytes.slice(from, to));
    from = Math.max(from, to);
  }
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function readAll(body: ReadableStream<Uint8Array>): Promise<EventStreamFrame[]> {
  const frames: EventStreamFrame[] = [];
  for await (const frame of readEventStream(body)) frames.push(frame);
  return frames;
}

/** What a route sends: a named frame whose one `data:` line is JSON (or, sometimes, not). */
const sentFrame = fc.record({
  event: fc.stringMatching(/^[a-z_]{1,10}$/),
  // `fc.string` with the full unicode range, so the UTF-8 encoding has 2-, 3-
  // and 4-byte characters for a cut to land inside. Line breaks are excluded:
  // a raw one would end the `data:` line, which no route here does.
  data: fc.oneof(
    fc.jsonValue().map((v) => JSON.stringify(v)),
    fc.string({ unit: "grapheme" }).map((s) => s.replace(/[\r\n]/g, " ")),
  ),
  // The heartbeat an idle stream sends between frames; must never surface.
  heartbeat: fc.boolean(),
});

type SentFrame = { event: string; data: string; heartbeat: boolean };

/** The bytes a route writes for `frames`, every line ended by `eol`. */
function toWire(frames: readonly SentFrame[], eol: string): string {
  return frames
    .map(({ event, data, heartbeat }) => {
      const ping = heartbeat ? `: ping${eol}${eol}` : "";
      return `${ping}event: ${event}${eol}data: ${data}${eol}${eol}`;
    })
    .join("");
}

/** The oracle for a frame's `data`, written independently of the reader. */
function jsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

type CutCounts = { midCharacter: number; midCrlf: number; midFrameEnd: number };

/** Count the cuts that land somewhere a naive reader would get wrong. */
function classifyCuts(bytes: Uint8Array, cuts: readonly number[], into: CutCounts): void {
  for (const at of cutPoints(bytes, cuts)) {
    const before = bytes[at - 1];
    const next = bytes[at];
    if (before === undefined || next === undefined) continue;
    if ((next & 0xc0) === 0x80) into.midCharacter++;
    if (before === 0x0d && next === 0x0a) into.midCrlf++;
    if (before === 0x0a && (next === 0x0a || next === 0x0d)) into.midFrameEnd++;
  }
}

describe("readEventStream", () => {
  test("the same bytes read as the same frames, however they are chunked", async () => {
    // The cuts the property is ABOUT: one landing on a UTF-8 continuation byte
    // (mid-character), one between a CRLF's `\r` and `\n`, and one between the
    // two line ends that close a frame.
    const reached = { midCharacter: 0, midCrlf: 0, midFrameEnd: 0, frames: 0 };
    await fc.assert(
      fc.asyncProperty(
        fc.array(sentFrame, { maxLength: 8 }),
        fc.constantFrom("\n", "\r\n"),
        fc.array(fc.nat(), { maxLength: 20 }),
        async (frames, eol, cuts) => {
          const bytes = new TextEncoder().encode(toWire(frames, eol));
          const expected = frames.map(({ event, data }) => ({
            event,
            data: jsonOrUndefined(data),
          }));
          classifyCuts(bytes, cuts, reached);
          reached.frames += expected.length;
          expect(await readAll(streamOf(bytes, cuts))).toEqual(expected);
        },
      ),
      { numRuns: 200 },
    );
    // Floors under the observed minimum; ranges are over 27 runs.
    expect(reached.midCharacter, "no cut landed inside a character").toBeGreaterThan(35); // 53-97
    expect(reached.midCrlf, "no cut split a CRLF").toBeGreaterThan(7); // 14-39
    expect(reached.midFrameEnd, "no cut split a frame's end").toBeGreaterThan(5); // 11-31
    expect(reached.frames, "too few frames sent").toBeGreaterThan(500); // 693-857
  });

  test("arbitrary bytes end the read cleanly, yielding only named frames", async () => {
    // Runs whose noise was well-formed enough to yield a frame: without any, the
    // "only named frames" half of the claim was never exercised.
    let yieldedAny = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.uint8Array({ maxLength: 256 }),
          // Noise built from the grammar's own pieces, so draws reach the parser's
          // field handling rather than one undecodable line.
          fc
            .array(
              fc.oneof(
                fc.constantFrom("event:", "data:", "id:", "retry:", ":", " ", "\n", "\r", "\r\n"),
                {
                  arbitrary: fc.constantFrom("event: run\n", "data: {}\n", "data: x\r\n", "\n\n"),
                  weight: 3,
                },
                fc.string({ maxLength: 8 }),
              ),
              { maxLength: 40 },
            )
            .map((parts) => new TextEncoder().encode(parts.join(""))),
        ),
        fc.array(fc.nat(), { maxLength: 10 }),
        async (bytes, cuts) => {
          const frames = await readAll(streamOf(bytes, cuts));
          if (frames.length > 0) yieldedAny++;
          for (const frame of frames) expect(typeof frame.event).toBe("string");
        },
      ),
      { numRuns: 300 },
    );
    expect(yieldedAny, "no noise ever parsed as a frame").toBeGreaterThan(3); // 9-20, over 15 runs
  });
});
