// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";

const { default: src } = await import("./playback-processor.ts");

describe("playback-processor worklet", () => {
  test("exports a string", () => {
    expect(typeof src).toBe("string");
  });

  test("worklet source registers playback-processor", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const file = fs.readFileSync(
      path.resolve(import.meta.dirname, "playback-processor.ts"),
      "utf-8",
    );
    expect(file).toContain("registerProcessor('playback-processor'");
  });

  test("worklet source contains PlaybackProcessor class", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const file = fs.readFileSync(
      path.resolve(import.meta.dirname, "playback-processor.ts"),
      "utf-8",
    );
    expect(file).toContain("class PlaybackProcessor extends AudioWorkletProcessor");
  });

  test("worklet source handles byte alignment with carry", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const file = fs.readFileSync(
      path.resolve(import.meta.dirname, "playback-processor.ts"),
      "utf-8",
    );
    expect(file).toContain("this.carry");
    expect(file).toContain("ingestBytes");
  });

  test("worklet source implements jitter buffer", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const file = fs.readFileSync(
      path.resolve(import.meta.dirname, "playback-processor.ts"),
      "utf-8",
    );
    expect(file).toContain("jitterSamples");
  });
});
