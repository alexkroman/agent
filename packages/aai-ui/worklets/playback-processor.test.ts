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
    expect(playbackProcessorSource).toContain("fillSamples");
  });

  test("converts even-aligned PCM16 to float and plays it back in order", () => {
    const w = makeProcessor();
    writePcm(w, [0x40_00, -0x80_00, 0x20_00, 0]);
    w.sendMessage({ event: "done" }); // start immediately (skip jitter wait)

    const out = render(w, 4);
    expect(Array.from(out)).toEqual([0.5, -1, 0.25, 0]);
    // Turn ends on the next render once the buffer has drained.
    render(w, 4);
    expect(w.posted).toContainEqual(expect.objectContaining({ event: "stop", reason: "done" }));
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

  test("a single render's copy splits cleanly across the ring wrap boundary", () => {
    // sampleRate 1 -> capacity 60, jitter 0: the wrap is reachable in-test.
    const w = makeProcessor(1);
    // Advance readPos to 59: write and fully render 59 samples.
    const first = Array.from({ length: 59 }, (_, i) => i + 1);
    writePcm(w, first);
    expect(Array.from(render(w, 59))).toEqual(first.map((v) => v / 0x80_00));

    // This run occupies ring index 59 and wraps to 0..28; a single render
    // must stitch the two segments back together with no gap or reorder.
    const second = Array.from({ length: 30 }, (_, i) => 100 + i);
    writePcm(w, second);
    const out = render(w, 30);
    expect(Array.from(out)).toEqual(second.map((v) => v / 0x80_00));
  });

  test("waits for the jitter buffer before playing", () => {
    // 24k rate -> jitter = 9600 samples; a small write must not start playback.
    const w = makeProcessor();
    writePcm(w, [1000, 2000]);
    const out = render(w, 4);
    expect(Array.from(out)).toEqual([0, 0, 0, 0]);
    expect(w.posted).toHaveLength(0); // turn not ended: still buffering
  });

  test("reports the backlog in the CONTEXT's rate, not the worklet global's", () => {
    // Everything else derived in the constructor reads the resolved `rate`;
    // `bufferedMs` read the global instead. Production never notices (the
    // option is unset, so the two are equal) and the node-less harness is the
    // only place that can assert on this number at all — which is what the
    // divergence made impossible. 1 kHz: the progress cadence is 500 samples
    // and the fill target 400, so one 600-sample render both starts playback
    // and crosses the report interval.
    const w = instantiateWorklet(playbackProcessorSource, { sampleRate: 1000 });
    writePcm(w, seq(1, 1200));
    render(w, 600);

    const progress = w.posted.find(
      (message) => (message as { event?: string }).event === "progress",
    ) as { bufferedMs: number } | undefined;
    // `avail` is read before the quantum is copied out, so the backlog is the
    // whole 1200 samples — 1200ms at 1 kHz. Read against the harness's 48 kHz
    // global it was 25ms: the same buffer, off by the ratio of the two rates.
    expect(progress?.bufferedMs).toBeCloseTo(1200, 5);
  });

  test("interrupt discards buffered audio and ends the turn", () => {
    const w = makeProcessor();
    writePcm(w, [1000, 2000, 3000]);
    w.sendMessage({ event: "done" });
    w.sendMessage({ event: "interrupt" });

    const out = render(w, 4);
    expect(Array.from(out)).toEqual([0, 0, 0, 0]);
    // The reason tag is what lets the host drop interrupt-stops instead of
    // letting them settle a later turn's done().
    expect(w.posted).toContainEqual(
      expect.objectContaining({ event: "stop", reason: "interrupt" }),
    );
  });
});

/** PCM16 integer -> the float the processor renders. */
const f = (v: number): number => v / 0x80_00;

/** `count` distinct ascending PCM values starting at `from`. */
const seq = (from: number, count: number): number[] =>
  Array.from({ length: count }, (_, i) => from + i);

type StopMessage = {
  event: string;
  reason: string;
  stats: {
    concealedSamples: number;
    silentConcealedSamples: number;
    concealmentEvents: number;
    silentConcealmentEvents: number;
  };
};

/** The turn-ending message, which carries that turn's concealment counters. */
const lastStop = (w: WorkletHarness): StopMessage => w.posted.at(-1) as StopMessage;

describe("playback-processor underrun handling", () => {
  // A 1 kHz context makes the fill target 20 samples instead of the 4800 a
  // realistic 24 kHz/200ms pairing needs, so a starve is reachable in-test.
  const tuned = (): WorkletHarness =>
    instantiateWorklet(playbackProcessorSource, {
      sampleRate: 1000,
      fillMs: 20,
    });

  test("re-enters buffering after an underrun instead of playing fragments", () => {
    const w = tuned();
    writePcm(w, seq(1, 20));
    expect(Array.from(render(w, 20))).toEqual(seq(1, 20).map(f));

    // The buffer is empty and the turn is not done: this quantum starves.
    render(w, 4);

    // A write below the refill target must not resume playback...
    writePcm(w, seq(21, 5));
    const early = Array.from(render(w, 5));
    const pending = new Set(seq(21, 5).map(f));
    expect(early.some((v) => pending.has(v))).toBe(false);

    // ...and when the target is finally met, playback resumes where it left
    // off: an underrun must never consume or reorder buffered audio.
    writePcm(w, seq(26, 15));
    expect(Array.from(render(w, 20))).toEqual(seq(21, 20).map(f));
  });

  test("conceals an underrun with the tail of played audio instead of hard silence", () => {
    const w = tuned();
    writePcm(w, new Array(20).fill(0x40_00));
    render(w, 20);

    const starved = Array.from(render(w, 4));
    expect(starved.every((v) => v !== 0)).toBe(true);
    // Concealment extrapolates from what played; it never gets louder.
    expect(Math.max(...starved.map(Math.abs))).toBeLessThanOrEqual(f(0x40_00));
  });

  test("reports concealment counters with the turn's stop message", () => {
    const w = tuned();
    writePcm(w, seq(1, 20));
    render(w, 20);
    render(w, 4); // one starve episode, 4 samples covered

    w.sendMessage({ event: "done" });
    render(w, 4); // drained + done -> turn ends

    const stop = lastStop(w);
    expect(stop.event).toBe("stop");
    const { stats } = stop;
    expect(stats.concealmentEvents).toBe(1);
    expect(stats.concealedSamples).toBe(4);
  });

  test("a long underrun fades to silence and counts it as silent concealment", () => {
    const w = tuned();
    writePcm(w, new Array(20).fill(0x40_00));
    render(w, 20);

    // Starve well past the fade window.
    for (let i = 0; i < 60; i++) render(w, 20);
    expect(Array.from(render(w, 20))).toEqual(new Array(20).fill(0));

    w.sendMessage({ event: "done" });
    render(w, 4);

    const stop = lastStop(w);
    expect(stop.event).toBe("stop");
    const { stats } = stop;
    expect(stats.silentConcealmentEvents).toBe(1);
    expect(stats.silentConcealedSamples).toBeGreaterThan(0);
    // Silent samples are a subset of concealed samples (WebRTC's semantics).
    expect(stats.silentConcealedSamples).toBeLessThan(stats.concealedSamples);
  });
});
