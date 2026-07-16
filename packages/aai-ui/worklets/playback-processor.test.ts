// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { instantiateWorklet, type WorkletHarness } from "./_worklet-test-utils.ts";

const { default: src, playbackProcessorSource } = await import("./playback-processor.ts");

function makeProcessor(sampleRate = 24_000): WorkletHarness {
  return instantiateWorklet(playbackProcessorSource, { sampleRate });
}

function writePcm(w: WorkletHarness, samples: number[], byteOffset = 0): void {
  // Optionally embed the PCM at an offset inside a larger buffer to exercise
  // the aligned/unaligned ingest paths.
  const backing = new Uint8Array(byteOffset + samples.length * 2);
  const view = new DataView(backing.buffer);
  for (const [i, s] of samples.entries()) {
    view.setInt16(byteOffset + i * 2, s, true);
  }
  w.sendMessage({ event: "write", buffer: backing.subarray(byteOffset) });
}

function render(w: WorkletHarness, length: number): Float32Array {
  const out = new Float32Array(length);
  w.instance.process([], [[out]]);
  return out;
}

describe("playback-processor worklet", () => {
  test("exports a Blob URL string and the raw source", () => {
    expect(typeof src).toBe("string");
    expect(playbackProcessorSource).toContain("registerProcessor('playback-processor'");
    expect(playbackProcessorSource).toContain(
      "class PlaybackProcessor extends AudioWorkletProcessor",
    );
    expect(playbackProcessorSource).toContain("jitterSamples");
  });

  test("converts even-aligned PCM16 to float and plays it back in order", () => {
    const w = makeProcessor();
    writePcm(w, [0x40_00, -0x80_00, 0x20_00, 0]);
    w.sendMessage({ event: "done" }); // start immediately (skip jitter wait)

    const out = render(w, 4);
    expect(Array.from(out)).toEqual([0.5, -1, 0.25, 0]);
    // Turn ends on the next render once the buffer has drained.
    render(w, 4);
    expect(w.posted).toContainEqual({ event: "stop" });
  });

  test("odd byte offset (DataView path) produces identical output", () => {
    const even = makeProcessor();
    const odd = makeProcessor();
    const samples = [1000, -2000, 3000, -32_768, 32_767];
    writePcm(even, samples, 0);
    writePcm(odd, samples, 1);
    even.sendMessage({ event: "done" });
    odd.sendMessage({ event: "done" });

    expect(Array.from(render(odd, 5))).toEqual(Array.from(render(even, 5)));
  });

  test("carries a split sample across chunk boundaries", () => {
    const w = makeProcessor();
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setInt16(0, 0x40_00, true);
    new DataView(bytes.buffer).setInt16(2, -0x40_00, true);
    // Send 3 bytes, then the remaining 1: the split sample must reassemble.
    w.sendMessage({ event: "write", buffer: bytes.subarray(0, 3) });
    w.sendMessage({ event: "write", buffer: bytes.subarray(3) });
    w.sendMessage({ event: "done" });

    const out = render(w, 2);
    expect(Array.from(out)).toEqual([0.5, -0.5]);
  });

  test("ring buffer wraps and drops the oldest overflow", () => {
    // sampleRate 1 -> capacity 60 samples, jitter 0 samples.
    const w = makeProcessor(1);
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    writePcm(w, samples);
    w.sendMessage({ event: "done" });

    // 100 written into a 60-slot ring: the 40 oldest were overwritten, so
    // playback starts at sample 41.
    const out = render(w, 4);
    expect(Array.from(out)).toEqual([41 / 0x80_00, 42 / 0x80_00, 43 / 0x80_00, 44 / 0x80_00]);
  });

  test("waits for the jitter buffer before playing", () => {
    // 24k rate -> jitter = 9600 samples; a small write must not start playback.
    const w = makeProcessor();
    writePcm(w, [1000, 2000]);
    const out = render(w, 4);
    expect(Array.from(out)).toEqual([0, 0, 0, 0]);
    expect(w.posted).toHaveLength(0); // turn not ended: still buffering
  });

  test("interrupt discards buffered audio and ends the turn", () => {
    const w = makeProcessor();
    writePcm(w, [1000, 2000, 3000]);
    w.sendMessage({ event: "done" });
    w.sendMessage({ event: "interrupt" });

    const out = render(w, 4);
    expect(Array.from(out)).toEqual([0, 0, 0, 0]);
    expect(w.posted).toContainEqual({ event: "stop" });
  });
});
