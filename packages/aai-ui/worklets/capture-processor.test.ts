// Copyright 2025 the AAI authors. MIT license.
import { beforeAll, describe, expect, test } from "vitest";
import {
  type FakePort,
  instantiateWorklet,
  loadWorkletSource,
  quantum,
  readWorkletSource,
  type WorkletProcessor,
} from "./_worklet-test-utils.ts";

const { default: src } = await import("./capture-processor.ts");

let source: string;

beforeAll(async () => {
  source = await loadWorkletSource("capture-processor.ts");
});

function start(
  processorOptions: Record<string, unknown>,
  sampleRateHz = 48_000,
): { processor: WorkletProcessor; port: FakePort } {
  const inst = instantiateWorklet(source, "capture-processor", processorOptions, sampleRateHz);
  inst.port.send({ event: "start" });
  return inst;
}

/** Decode every posted chunk into one flat PCM16 sample array. */
function postedSamples(port: FakePort): number[] {
  const out: number[] = [];
  for (const buffer of port.chunks()) {
    const view = new DataView(buffer);
    for (let i = 0; i < buffer.byteLength; i += 2) out.push(view.getInt16(i, true));
  }
  return out;
}

describe("capture-processor worklet", () => {
  test("exports a Blob URL string", () => {
    expect(typeof src).toBe("string");
  });

  test("worklet source registers capture-processor", async () => {
    const file = await readWorkletSource("capture-processor.ts");
    expect(file).toContain("registerProcessor('capture-processor'");
    expect(file).toContain("class CaptureProcessor extends AudioWorkletProcessor");
    expect(file).toContain("resample(input)");
  });

  test("drops audio until 'start' arrives", () => {
    const { processor, port } = instantiateWorklet(source, "capture-processor", {
      contextRate: 16_000,
      sttSampleRate: 16_000,
      chunkSamples: 2,
    });
    processor.process(quantum([0.5, 0.5, 0.5, 0.5]), [], {});
    expect(port.posted).toHaveLength(0);
  });

  test("posts one chunk per chunkSamples, not per render quantum", () => {
    const { processor, port } = start({
      contextRate: 16_000,
      sttSampleRate: 16_000,
      chunkSamples: 8,
    });
    // Four 2-sample quanta fill exactly one 8-sample chunk.
    for (let i = 0; i < 4; i++) processor.process(quantum([0.25, -0.25]), [], {});
    expect(port.chunks()).toHaveLength(1);
    expect(port.chunks()[0]?.byteLength).toBe(16);

    // A fifth quantum starts the next chunk but must not post it early.
    processor.process(quantum([0.25, -0.25]), [], {});
    expect(port.chunks()).toHaveLength(1);
  });

  test("converts Float32 to PCM16 with full-scale endpoints and clamping", () => {
    const { processor, port } = start({
      contextRate: 8000,
      sttSampleRate: 8000,
      chunkSamples: 6,
    });
    processor.process(quantum([0, 1, -1, 0.5, 2, -3]), [], {});
    expect(postedSamples(port)).toEqual([0, 32_767, -32_768, 16_383, 32_767, -32_768]);
  });

  test("emits little-endian bytes regardless of host byte order", () => {
    const { processor, port } = start({ contextRate: 8000, sttSampleRate: 8000, chunkSamples: 1 });
    processor.process(quantum([1]), [], {});
    // 32767 = 0x7FFF → low byte first.
    expect([...new Uint8Array(port.chunks()[0] as ArrayBuffer)]).toEqual([0xff, 0x7f]);
  });

  test("'stop' flushes the partial chunk and halts capture", () => {
    const { processor, port } = start({
      contextRate: 8000,
      sttSampleRate: 8000,
      chunkSamples: 16,
    });
    processor.process(quantum([1, 1, 1]), [], {});
    expect(port.chunks()).toHaveLength(0);

    port.send({ event: "stop" });
    expect(port.chunks()).toHaveLength(1);
    expect(port.chunks()[0]?.byteLength).toBe(6);

    processor.process(quantum([1, 1, 1]), [], {});
    expect(port.chunks()).toHaveLength(1);
  });

  test("resamples down to the STT rate, preserving the sample clock across blocks", () => {
    const { processor, port } = start({
      contextRate: 16_000,
      sttSampleRate: 8000,
      chunkSamples: 4,
    });
    // 2:1 decimation — 8 input samples across two quanta yield 4 outputs.
    processor.process(quantum([1, 0, 1, 0]), [], {});
    processor.process(quantum([1, 0, 1, 0]), [], {});
    expect(postedSamples(port)).toHaveLength(4);
  });

  test("ignores empty inputs and missing channels", () => {
    const { processor, port } = start({ contextRate: 8000, sttSampleRate: 8000, chunkSamples: 4 });
    expect(processor.process([], [], {})).toBe(true);
    expect(processor.process([[]], [], {})).toBe(true);
    expect(port.posted).toHaveLength(0);
  });

  test("defaults chunkSamples to ~100 ms of the STT rate", () => {
    const { processor, port } = start({ contextRate: 16_000, sttSampleRate: 16_000 });
    // 1600 samples = 100 ms at 16 kHz; 1599 must not post yet.
    processor.process(quantum(Array.from({ length: 1599 }, () => 0.1)), [], {});
    expect(port.chunks()).toHaveLength(0);
    processor.process(quantum([0.1]), [], {});
    expect(port.chunks()[0]?.byteLength).toBe(3200);
  });
});
