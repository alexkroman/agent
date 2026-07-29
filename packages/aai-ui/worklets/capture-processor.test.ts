// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { instantiateWorklet } from "./_worklet-test-utils.ts";

const { default: src, captureProcessorSource } = await import("./capture-processor.ts");
const { playbackProcessorSource } = await import("./playback-processor.ts");

type ChunkMessage = { event: string; buffer: ArrayBuffer };

function chunks(posted: unknown[]): ChunkMessage[] {
  return posted.filter((p): p is ChunkMessage => (p as ChunkMessage).event === "chunk");
}

/** Concatenate every posted chunk into one Int16Array, in order. */
function allSamples(posted: unknown[]): Int16Array {
  const parts = chunks(posted).map((c) => new Int16Array(c.buffer));
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Invert the worklet's asymmetric Int16 encoding back to float. */
function toFloat(v: number): number {
  return v < 0 ? v / 0x80_00 : v / 0x7f_ff;
}

/** Feed a linear ramp (value = index / scale) through the processor. */
function feedRamp(w: ReturnType<typeof instantiateWorklet>, quanta: number, scale: number): number {
  let idx = 0;
  for (let q = 0; q < quanta; q++) {
    const input = new Float32Array(128);
    for (let i = 0; i < 128; i++) input[i] = idx++ / scale;
    w.instance.process([[input]], []);
  }
  return idx;
}

function quantum(value: number, length = 128): Float32Array[][] {
  const input = new Float32Array(length);
  input.fill(value);
  return [[input]];
}

describe("capture-processor worklet", () => {
  test("exports a Blob URL string and the raw source", () => {
    expect(typeof src).toBe("string");
    expect(captureProcessorSource).toContain("registerProcessor('capture-processor'");
    expect(captureProcessorSource).toContain(
      "class CaptureProcessor extends AudioWorkletProcessor",
    );
  });

  test("batches quanta and posts one buffer per flush interval", () => {
    // No resample; target = 16000 * 0.016 = 256 samples = two 128-sample quanta.
    const w = instantiateWorklet(captureProcessorSource, {
      contextRate: 16_000,
      sttSampleRate: 16_000,
      bufferSeconds: 0.016,
    });
    w.sendMessage({ event: "start" });

    w.instance.process(quantum(0.5), []);
    expect(chunks(w.posted)).toHaveLength(0); // below target: no post yet

    w.instance.process(quantum(0.5), []);
    const posted = chunks(w.posted);
    expect(posted).toHaveLength(1); // one message for both quanta
    const pcm = new Int16Array(posted[0]?.buffer ?? new ArrayBuffer(0));
    expect(pcm.length).toBe(256);
    expect(pcm[0]).toBe(Math.floor(0.5 * 0x7f_ff));
    expect(pcm[255]).toBe(Math.floor(0.5 * 0x7f_ff));
  });

  test("clamps out-of-range samples and preserves negative scaling", () => {
    const w = instantiateWorklet(captureProcessorSource, {
      contextRate: 16_000,
      sttSampleRate: 16_000,
      bufferSeconds: 0.008, // 128 samples: flush every quantum
    });
    w.sendMessage({ event: "start" });

    const input = new Float32Array(128);
    input[0] = 2; // clamps to 1
    input[1] = -2; // clamps to -1
    input[2] = -0.5;
    w.instance.process([[input]], []);

    const pcm = new Int16Array(chunks(w.posted)[0]?.buffer ?? new ArrayBuffer(0));
    expect(pcm[0]).toBe(0x7f_ff);
    expect(pcm[1]).toBe(-0x80_00);
    expect(pcm[2]).toBe(-0.5 * 0x80_00);
    expect(pcm[3]).toBe(0);
  });

  test("flushes the partial batch on stop", () => {
    const w = instantiateWorklet(captureProcessorSource, {
      contextRate: 16_000,
      sttSampleRate: 16_000,
      bufferSeconds: 0.1, // 1600-sample target: one quantum stays buffered
    });
    w.sendMessage({ event: "start" });
    w.instance.process(quantum(0.25), []);
    expect(chunks(w.posted)).toHaveLength(0);

    w.sendMessage({ event: "stop" });
    const posted = chunks(w.posted);
    expect(posted).toHaveLength(1);
    expect(new Int16Array(posted[0]?.buffer ?? new ArrayBuffer(0)).length).toBe(128);

    // Recording stopped: further quanta are ignored.
    w.instance.process(quantum(0.25), []);
    expect(chunks(w.posted)).toHaveLength(1);
  });

  test("resamples to the STT rate before batching", () => {
    // 48k -> 16k: each 128-sample quantum yields ~42-43 output samples.
    const w = instantiateWorklet(captureProcessorSource, {
      contextRate: 48_000,
      sttSampleRate: 16_000,
      bufferSeconds: 0.008, // 128-sample target at 16k = ~3 quanta
    });
    w.sendMessage({ event: "start" });
    for (let i = 0; i < 4; i++) w.instance.process(quantum(0.5), []);

    const posted = chunks(w.posted);
    expect(posted).toHaveLength(1);
    const pcm = new Int16Array(posted[0]?.buffer ?? new ArrayBuffer(0));
    // 4 quanta * 128 / 3 ≈ 170 output samples, flushed once 128 was reached.
    expect(pcm.length).toBeGreaterThanOrEqual(128);
    expect(pcm.length).toBeLessThan(200);
    // Constant signal resamples to the same constant.
    expect(pcm[10]).toBe(Math.floor(0.5 * 0x7f_ff));
  });

  test("resampling a ramp at 48k→16k preserves values and the sample clock", () => {
    const w = instantiateWorklet(captureProcessorSource, {
      contextRate: 48_000,
      sttSampleRate: 16_000,
      bufferSeconds: 1, // 16000-sample target: nothing flushes until stop
    });
    w.sendMessage({ event: "start" });
    const total = feedRamp(w, 30, 4096); // 3840 input samples
    w.sendMessage({ event: "stop" }); // flush the tail

    const pcm = allSamples(w.posted);
    // Integer ratio 3: exactly one output per 3 inputs, no drift across the
    // 30 block boundaries.
    expect(Math.abs(pcm.length - total / 3)).toBeLessThanOrEqual(1);
    // Output k sits at input position k*3 — linear interpolation of a linear
    // ramp is exact, so only Int16 quantization error remains.
    let maxErr = 0;
    for (let k = 0; k < pcm.length; k++) {
      const expected = (k * 3) / 4096;
      maxErr = Math.max(maxErr, Math.abs(toFloat(pcm[k] ?? 0) - expected));
    }
    expect(maxErr).toBeLessThanOrEqual(1e-4);
  });

  test("non-integer ratio 44.1k→16k keeps count and values on the ideal clock", () => {
    const ratio = 44_100 / 16_000; // 2.75625
    const w = instantiateWorklet(captureProcessorSource, {
      contextRate: 44_100,
      sttSampleRate: 16_000,
      bufferSeconds: 1,
    });
    w.sendMessage({ event: "start" });
    const total = feedRamp(w, 40, 6144); // 5120 input samples
    w.sendMessage({ event: "stop" });

    const pcm = allSamples(w.posted);
    expect(Math.abs(pcm.length - (total * 16_000) / 44_100)).toBeLessThanOrEqual(2);
    let maxErr = 0;
    for (let k = 0; k < pcm.length; k++) {
      const expected = (k * ratio) / 6144;
      maxErr = Math.max(maxErr, Math.abs(toFloat(pcm[k] ?? 0) - expected));
    }
    expect(maxErr).toBeLessThanOrEqual(1e-4);
  });

  test("stop posts the tail flush chunk before the stopped ack", () => {
    const w = instantiateWorklet(captureProcessorSource, {
      contextRate: 16_000,
      sttSampleRate: 16_000,
      bufferSeconds: 0.1, // 1600-sample target: one quantum stays buffered
    });
    w.sendMessage({ event: "start" });
    w.instance.process(quantum(0.25), []);
    expect(w.posted).toHaveLength(0);

    w.sendMessage({ event: "stop" });
    // Ordering is the contract close() relies on: by the time the host sees
    // 'stopped', the tail chunk has already been posted.
    const events = w.posted.map((p) => (p as { event: string }).event);
    expect(events).toEqual(["chunk", "stopped"]);
  });

  test("PCM16 round-trips from capture accumulate to playback ingest", () => {
    // Edge and dyadic values: their asymmetric encode/decode error is at
    // most exactly one quantization step (1/0x8000).
    const values = [-1, 1, 0, 0.5, -0.5, 0.25, -0.25, -0.75, 0.125];
    const input = new Float32Array(128);
    input.set(values);

    const cap = instantiateWorklet(captureProcessorSource, {
      contextRate: 16_000,
      sttSampleRate: 16_000,
      bufferSeconds: 0.008, // 128 samples: flush every quantum
    });
    cap.sendMessage({ event: "start" });
    cap.instance.process([[input]], []);
    const posted = chunks(cap.posted);
    expect(posted).toHaveLength(1);
    const chunk = posted[0]?.buffer as ArrayBuffer;
    expect(chunk.byteLength).toBe(256);

    const play = instantiateWorklet(playbackProcessorSource, { sampleRate: 24_000 });
    play.sendMessage({ event: "write", buffer: new Uint8Array(chunk) });
    play.sendMessage({ event: "done" }); // start immediately (skip jitter wait)
    const out = new Float32Array(128);
    play.instance.process([], [[out]]);

    let maxErr = 0;
    for (let i = 0; i < input.length; i++) {
      maxErr = Math.max(maxErr, Math.abs((out[i] ?? 0) - (input[i] ?? 0)));
    }
    expect(maxErr).toBeLessThanOrEqual(1 / 0x80_00);
  });

  test("does not record before start", () => {
    const w = instantiateWorklet(captureProcessorSource, {
      contextRate: 16_000,
      sttSampleRate: 16_000,
      bufferSeconds: 0.008,
    });
    w.instance.process(quantum(0.5), []);
    expect(chunks(w.posted)).toHaveLength(0);
  });
});
