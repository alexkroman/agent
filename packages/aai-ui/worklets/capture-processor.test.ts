// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const { default: src } = await import("./capture-processor.ts");
const file = fs.readFileSync(path.resolve(import.meta.dirname, "capture-processor.ts"), "utf-8");

describe("capture-processor worklet", () => {
  test("exports a string", () => {
    expect(typeof src).toBe("string");
  });

  test("worklet source registers capture-processor", () => {
    expect(file).toContain("registerProcessor('capture-processor'");
  });

  test("worklet source contains CaptureProcessor class", () => {
    expect(file).toContain("class CaptureProcessor extends AudioWorkletProcessor");
  });

  test("worklet source contains resample method", () => {
    expect(file).toContain("resample(input)");
  });

  test("worklet source converts Float32 to Int16", () => {
    expect(file).toContain("setInt16");
  });
});
