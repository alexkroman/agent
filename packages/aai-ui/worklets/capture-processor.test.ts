// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { instantiateWorklet } from "./_worklet-test-utils.ts";

const { default: src, captureProcessorSource } = await import("./capture-processor.ts");
const { playbackProcessorSource } = await import("./playback-processor.ts");

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
      sampleRate: 16_000,
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
      sampleRate: 16_000,
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
      sampleRate: 16_000,
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

  test("stop posts the tail flush chunk before the stopped ack", () => {
    const w = instantiateWorklet(captureProcessorSource, {
      sampleRate: 16_000,
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
      sampleRate: 16_000,
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
      sampleRate: 16_000,
      bufferSeconds: 0.008,
    });
    w.instance.process(quantum(0.5), []);
    expect(chunks(w.posted)).toHaveLength(0);
  });
});

/**
 * Dead-mic probe. A device muted at the OS level, or simply the wrong input,
 * delivers digital silence — indistinguishable from a user who has not spoken
 * yet, so a broken setup looks like a working session nobody is talking to.
 */
describe("capture-processor dead-mic probe", () => {
  /** 128 samples/quantum at 16 kHz = 8ms, so 16 quanta is one 128ms window. */
  const probe = (): ReturnType<typeof instantiateWorklet> =>
    instantiateWorklet(captureProcessorSource, {
      sampleRate: 16_000,
      bufferSeconds: 0.016,
      silenceProbeMs: 128,
    });

  const silentReports = (posted: unknown[]): unknown[] =>
    posted.filter((p) => (p as { event: string }).event === "silent");

  test("reports a microphone that produces only digital silence", () => {
    const w = probe();
    w.sendMessage({ event: "start" });

    for (let q = 0; q < 16; q++) w.instance.process(quantum(0), []);

    expect(silentReports(w.posted)).toHaveLength(1);
  });

  test("stays quiet for a microphone that produces signal", () => {
    const w = probe();
    w.sendMessage({ event: "start" });

    // A device that starts with a few empty quanta is normal; one real sample
    // is enough to prove the input is live.
    w.instance.process(quantum(0), []);
    w.instance.process(quantum(0.01), []);
    for (let q = 0; q < 30; q++) w.instance.process(quantum(0), []);

    expect(silentReports(w.posted)).toHaveLength(0);
  });

  test("reports at most once for one dead microphone", () => {
    const w = probe();
    w.sendMessage({ event: "start" });

    for (let q = 0; q < 100; q++) w.instance.process(quantum(0), []);

    expect(silentReports(w.posted)).toHaveLength(1);
  });

  test("does not probe before recording starts", () => {
    const w = probe();

    // No 'start': the mic is not expected to be producing anything yet.
    for (let q = 0; q < 40; q++) w.instance.process(quantum(0), []);

    expect(silentReports(w.posted)).toHaveLength(0);
  });
});
