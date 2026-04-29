// Copyright 2025 the AAI authors. MIT license.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const { default: src } = await import("./playback-processor.ts");
const file = readFileSync(resolve(import.meta.dirname, "playback-processor.ts"), "utf-8");

describe("playback-processor worklet", () => {
  test("exports a string", () => {
    expect(typeof src).toBe("string");
  });

  test("worklet source registers playback-processor", () => {
    expect(file).toContain("registerProcessor('playback-processor'");
  });

  test("worklet source contains PlaybackProcessor class", () => {
    expect(file).toContain("class PlaybackProcessor extends AudioWorkletProcessor");
  });

  test("worklet source handles byte alignment with carry", () => {
    expect(file).toContain("this.carry");
    expect(file).toContain("ingestBytes");
  });

  test("worklet source implements jitter buffer", () => {
    expect(file).toContain("jitterSamples");
  });
});
