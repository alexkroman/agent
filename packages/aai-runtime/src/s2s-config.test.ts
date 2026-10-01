// Copyright 2026 the AAI authors. MIT license.
import {
  ASSEMBLYAI_S2S_SAMPLE_RATE,
  DEFAULT_STT_SAMPLE_RATE,
  DEFAULT_TTS_SAMPLE_RATE,
} from "@alexkroman1/aai/host-internal";
import { describe, expect, test } from "vitest";
import { makeLogger } from "./_logger-test-utils.ts";
import { DEFAULT_S2S_CONFIG, pinAssemblyS2sRates, type S2sConfig } from "./s2s-config.ts";

describe("DEFAULT_S2S_CONFIG", () => {
  test("carries the SDK's STT and TTS defaults, not the Voice Agent API's one rate", () => {
    expect(DEFAULT_S2S_CONFIG).toEqual({
      wssUrl: "wss://agents.assemblyai.com/v1/ws",
      inputSampleRate: DEFAULT_STT_SAMPLE_RATE,
      outputSampleRate: DEFAULT_TTS_SAMPLE_RATE,
    });
  });
});

describe("pinAssemblyS2sRates", () => {
  const rate = ASSEMBLYAI_S2S_SAMPLE_RATE;

  test("an already-pinned config comes back as the SAME object, with no warning", () => {
    const log = makeLogger();
    const pinned: S2sConfig = { wssUrl: "wss://x", inputSampleRate: rate, outputSampleRate: rate };
    expect(pinAssemblyS2sRates(pinned, log)).toBe(pinned);
    expect(log.warn).not.toHaveBeenCalled();
  });

  test("forces both rates onto the one supported rate and keeps the rest", () => {
    const requested: S2sConfig = {
      wssUrl: "wss://custom",
      inputSampleRate: 16_000,
      outputSampleRate: 22_050,
    };
    expect(pinAssemblyS2sRates(requested)).toEqual({
      wssUrl: "wss://custom",
      inputSampleRate: rate,
      outputSampleRate: rate,
    });
    // The caller's config is not mutated.
    expect(requested.inputSampleRate).toBe(16_000);
  });

  test("warns once, naming the rates it overrode", () => {
    const log = makeLogger();
    pinAssemblyS2sRates(
      { wssUrl: "wss://x", inputSampleRate: 16_000, outputSampleRate: rate },
      log,
    );
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("pinned"), {
      requestedInputSampleRate: 16_000,
      requestedOutputSampleRate: rate,
      sampleRate: rate,
    });
  });
});
