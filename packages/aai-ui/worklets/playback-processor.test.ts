// Copyright 2025 the AAI authors. MIT license.
import { beforeAll, describe, expect, test } from "vitest";
import {
  type FakePort,
  instantiateWorklet,
  loadWorkletSource,
  pcm16Bytes,
  readWorkletSource,
  type WorkletProcessor,
} from "./_worklet-test-utils.ts";

const { default: src } = await import("./playback-processor.ts");

/** Small rate keeps the worklet's 60 s ring buffer tiny in tests. */
const RATE = 100;
/** jitterSamples = floor(RATE * 0.4). */
const JITTER = 40;

let source: string;

beforeAll(async () => {
  source = await loadWorkletSource("playback-processor.ts");
});

function create(rate = RATE): { processor: WorkletProcessor; port: FakePort } {
  return instantiateWorklet(source, "playback-processor", { sampleRate: rate });
}

/** Run one render quantum of `size` frames and return the output channel. */
function render(processor: WorkletProcessor, size: number): Float32Array {
  const out = new Float32Array(size);
  processor.process([], [[out]], {});
  return out;
}

function write(port: FakePort, samples: number[]): void {
  port.send({ event: "write", buffer: pcm16Bytes(samples) });
}

describe("playback-processor worklet", () => {
  test("exports a Blob URL string", () => {
    expect(typeof src).toBe("string");
  });

  test("worklet source registers playback-processor", async () => {
    const file = await readWorkletSource("playback-processor.ts");
    expect(file).toContain("registerProcessor('playback-processor'");
    expect(file).toContain("class PlaybackProcessor extends AudioWorkletProcessor");
    expect(file).toContain("jitterSamples");
    expect(file).toContain("this.carry");
    expect(file).toContain("ingestBytes");
  });

  test("keeps the processor alive across renders", () => {
    const { processor } = create();
    // Returning false would kill the node for good, forcing a new one (and a
    // fresh multi-MB ring buffer) per reply.
    expect(processor.process([], [[new Float32Array(4)]], {})).toBe(true);
  });

  test("decodes little-endian PCM16 to normalized floats", () => {
    const { processor, port } = create();
    write(port, [0, 1, -1, 0.5]);
    port.send({ event: "done" });
    const out = render(processor, 6);
    expect(out[0]).toBe(0);
    expect(out[1]).toBeCloseTo(1, 4);
    expect(out[2]).toBe(-1);
    expect(out[3]).toBeCloseTo(0.5, 4);
    // Tail beyond the available samples is zero-filled.
    expect(out[4]).toBe(0);
    expect(out[5]).toBe(0);
  });

  test("holds output silent until the jitter buffer fills", () => {
    const { processor, port } = create();
    write(
      port,
      Array.from({ length: JITTER - 1 }, () => 1),
    );
    expect([...render(processor, 4)]).toEqual([0, 0, 0, 0]);

    // One more sample crosses the threshold and playback starts.
    write(port, [1]);
    expect(render(processor, 4)[0]).toBeCloseTo(1, 4);
  });

  test("'done' starts playback immediately for a short utterance", () => {
    const { processor, port } = create();
    write(port, [1, 1]);
    port.send({ event: "done" });
    expect(render(processor, 2)[0]).toBeCloseTo(1, 4);
  });

  test("carries a split sample across chunk boundaries", () => {
    const { processor, port } = create();
    const bytes = pcm16Bytes([1, -1]);
    // Split mid-sample: 3 bytes then 1 byte.
    port.send({ event: "write", buffer: bytes.subarray(0, 3) });
    port.send({ event: "write", buffer: bytes.subarray(3) });
    port.send({ event: "done" });
    const out = render(processor, 2);
    expect(out[0]).toBeCloseTo(1, 4);
    expect(out[1]).toBe(-1);
  });

  test("decodes a misaligned byte view identically", () => {
    const { processor, port } = create();
    const aligned = pcm16Bytes([1, -1]);
    // Offset by one byte so the fast Int16Array path can't be used.
    const padded = new Uint8Array(aligned.byteLength + 1);
    padded.set(aligned, 1);
    port.send({ event: "write", buffer: padded.subarray(1) });
    port.send({ event: "done" });
    const out = render(processor, 2);
    expect(out[0]).toBeCloseTo(1, 4);
    expect(out[1]).toBe(-1);
  });

  test("drops the oldest audio when the producer outruns the ring buffer", () => {
    // capacity = rate * 60; keep it small so the overrun is cheap to write.
    const { processor, port } = create(2);
    const capacity = 2 * 60;
    // Write capacity + 4 samples of alternating polarity: the surviving window
    // must keep its phase, which pins down the wrap arithmetic.
    write(
      port,
      Array.from({ length: capacity + 4 }, (_, i) => (i % 2 === 0 ? 0.5 : -0.5)),
    );
    port.send({ event: "done" });
    const out = render(processor, capacity);
    // The retained window starts 4 samples in, so parity is preserved and no
    // sample reads as an unwritten zero.
    expect(out[0]).toBeCloseTo(0.5, 4);
    expect(out.some((v) => v === 0)).toBe(false);
  });

  test("'interrupt' zeroes the output, reports stop, and rearms", () => {
    const { processor, port } = create();
    write(
      port,
      Array.from({ length: JITTER }, () => 1),
    );
    port.send({ event: "interrupt" });
    expect([...render(processor, 4)]).toEqual([0, 0, 0, 0]);
    expect(port.posted).toEqual([{ event: "stop" }]);

    // Rearmed: a fresh turn plays without needing a new node.
    write(port, [1, 1]);
    port.send({ event: "done" });
    expect(render(processor, 2)[0]).toBeCloseTo(1, 4);
  });

  test("reports stop once the buffer drains after 'done'", () => {
    const { processor, port } = create();
    write(port, [1]);
    port.send({ event: "done" });
    render(processor, 4);
    expect(port.posted).toHaveLength(0);
    render(processor, 4);
    expect(port.posted).toEqual([{ event: "stop" }]);
  });

  test("ignores empty writes", () => {
    const { processor, port } = create();
    port.send({ event: "write", buffer: new Uint8Array(0) });
    port.send({ event: "done" });
    render(processor, 2);
    expect(port.posted).toEqual([{ event: "stop" }]);
  });
});
