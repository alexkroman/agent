// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { DEFAULT_STT_SAMPLE_RATE, DEFAULT_TTS_SAMPLE_RATE } from "./constants.ts";
import { ASSEMBLYAI_S2S_SAMPLE_RATE } from "./s2s-constants.ts";

describe("ASSEMBLYAI_S2S_SAMPLE_RATE", () => {
  test("is 24 kHz — 16 kHz bytes relabelled as 24 kHz leave the agent deaf", () => {
    expect(ASSEMBLYAI_S2S_SAMPLE_RATE).toBe(24_000);
    expect(ASSEMBLYAI_S2S_SAMPLE_RATE).not.toBe(DEFAULT_STT_SAMPLE_RATE);
  });

  test("matches the TTS rate, so one client output path serves both modes", () => {
    expect(ASSEMBLYAI_S2S_SAMPLE_RATE).toBe(DEFAULT_TTS_SAMPLE_RATE);
  });
});
