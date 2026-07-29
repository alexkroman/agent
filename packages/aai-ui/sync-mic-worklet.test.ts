// Copyright 2026 the AAI authors. MIT license.
/**
 * The sync capture processor's own behavior, evaluated as source.
 *
 * `sync-mic.test.ts` covers the glue *around* the worklet by emitting chunk
 * messages from a mock node, so the processor body itself ran only in a real
 * browser. That gap hid a wedge: the batch buffer was re-allocated from the
 * length of a view whose buffer had just been transferred (and so detached to
 * length 0), after which `process()` never returned and only empty chunks
 * reached the main thread. These tests run the real source through the
 * transfer-faithful harness.
 */

import { describe, expect, test } from "vitest";
import { CAPTURE_BATCH_SAMPLES, CAPTURE_PROCESSOR_SRC } from "./sync-mic.ts";
import { instantiateWorklet } from "./worklets/_worklet-test-utils.ts";

type Chunk = { event: string; samples: Float32Array };

/** One render quantum of a constant-amplitude signal. */
function quantum(amplitude: number, size = 128): Float32Array {
  return new Float32Array(size).fill(amplitude);
}

/** Feed `n` quanta of `amplitude`; returns the chunks posted and the keep-alive returns. */
function render(amplitude: number, quanta: number): { posted: Chunk[]; alive: boolean } {
  const { instance, posted } = instantiateWorklet(CAPTURE_PROCESSOR_SRC, {}, 16_000);
  let alive = true;
  for (let i = 0; i < quanta; i++) {
    alive = instance.process([[quantum(amplitude)]], [[new Float32Array(128)]]) && alive;
  }
  return { posted: posted as Chunk[], alive };
}

describe("sync capture worklet", () => {
  test("batches render quanta into full-size chunks", () => {
    const { posted, alive } = render(0.5, CAPTURE_BATCH_SAMPLES / 128);

    expect(alive).toBe(true);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.event).toBe("chunk");
    expect(posted[0]?.samples).toHaveLength(CAPTURE_BATCH_SAMPLES);
  });

  test("keeps capturing after the first flush transfers its buffer", () => {
    // Three batches' worth. Every batch must be full and carry the signal —
    // reusing a detached buffer's length yielded empty chunks from #2 on.
    const { posted } = render(0.5, (CAPTURE_BATCH_SAMPLES / 128) * 3);

    expect(posted).toHaveLength(3);
    for (const chunk of posted) {
      expect(chunk.samples).toHaveLength(CAPTURE_BATCH_SAMPLES);
      expect(Math.max(...chunk.samples)).toBeCloseTo(0.5, 5);
    }
  });

  test("silence still produces full-size chunks (the VAD needs them)", () => {
    // A zero-length frame is dropped by the detector, so an empty chunk is
    // indistinguishable from "no audio" — silence must arrive as real frames.
    const { posted } = render(0, (CAPTURE_BATCH_SAMPLES / 128) * 2);

    expect(posted).toHaveLength(2);
    for (const chunk of posted) expect(chunk.samples).toHaveLength(CAPTURE_BATCH_SAMPLES);
  });

  test("an absent input is a no-op, not a flush", () => {
    const { instance, posted } = instantiateWorklet(CAPTURE_PROCESSOR_SRC, {}, 16_000);

    expect(instance.process([[]], [[new Float32Array(128)]])).toBe(true);
    expect(instance.process([], [[new Float32Array(128)]])).toBe(true);

    expect(posted).toHaveLength(0);
  });

  test("honors a processorOptions batch size", () => {
    const { instance, posted } = instantiateWorklet(
      CAPTURE_PROCESSOR_SRC,
      { batchSamples: 256 },
      16_000,
    );
    for (let i = 0; i < 4; i++) instance.process([[quantum(0.25)]], [[new Float32Array(128)]]);

    expect(posted).toHaveLength(2);
    expect((posted[1] as Chunk).samples).toHaveLength(256);
  });
});
