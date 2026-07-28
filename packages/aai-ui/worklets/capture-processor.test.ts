// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { instantiateWorklet } from "./_worklet-test-utils.ts";

const { default: src, captureProcessorSource } = await import("./capture-processor.ts");

type ChunkMessage = { event: string; buffer: ArrayBuffer };

function chunks(posted: unknown[]): ChunkMessage[] {
  return posted.filter((p): p is ChunkMessage => (p as ChunkMessage).event === "chunk");
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
