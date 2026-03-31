// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";

// Mock browser APIs before importing the module
globalThis.Blob = class Blob {
  parts: string[];
  constructor(parts: string[]) {
    this.parts = parts;
  }
} as unknown as typeof Blob;
globalThis.URL.createObjectURL = () => "blob:mock";

const { default: src } = await import("./capture-processor.ts");

describe("capture-processor worklet", () => {
  test("exports a string", () => {
    expect(typeof src).toBe("string");
  });

  test("worklet source registers capture-processor", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const file = fs.readFileSync(
      path.resolve(import.meta.dirname, "capture-processor.ts"),
      "utf-8",
    );
    expect(file).toContain("registerProcessor('capture-processor'");
  });

  test("worklet source contains CaptureProcessor class", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const file = fs.readFileSync(
      path.resolve(import.meta.dirname, "capture-processor.ts"),
      "utf-8",
    );
    expect(file).toContain("class CaptureProcessor extends AudioWorkletProcessor");
  });

  test("worklet source contains resample method", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const file = fs.readFileSync(
      path.resolve(import.meta.dirname, "capture-processor.ts"),
      "utf-8",
    );
    expect(file).toContain("resample(input)");
  });

  test("worklet source converts Float32 to Int16", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const file = fs.readFileSync(
      path.resolve(import.meta.dirname, "capture-processor.ts"),
      "utf-8",
    );
    expect(file).toContain("setInt16");
  });
});
