// Copyright 2026 the AAI authors. MIT license.
/** Unit test for the `assemblyAISyncStt()` descriptor and its resolved settings. */

import { describe, expect, test } from "vitest";
import {
  ASSEMBLYAI_SYNC_API_KEY_ENV,
  ASSEMBLYAI_SYNC_DEFAULT_MIN_TURN_SILENCE_MS,
  ASSEMBLYAI_SYNC_DEFAULT_MODEL,
  ASSEMBLYAI_SYNC_DEFAULT_PARTIAL_INTERVAL_MS,
  ASSEMBLYAI_SYNC_DEFAULT_SPEECH_THRESHOLD_DBFS,
  ASSEMBLYAI_SYNC_DEFAULT_URL,
  ASSEMBLYAI_SYNC_STT_KIND,
  assemblyAISyncStt,
  resolveAssemblyAISyncSttSettings,
} from "./assemblyai-sync.ts";

describe("assemblyAISyncStt", () => {
  test("returns a pure descriptor that copies its options", () => {
    const options = { model: "m", apiKeyEnv: "MY_KEY" };
    const descriptor = assemblyAISyncStt(options);
    expect(descriptor).toEqual({ kind: ASSEMBLYAI_SYNC_STT_KIND, options });
    expect(descriptor.options).not.toBe(options);
  });

  test("takes no options", () => {
    expect(assemblyAISyncStt()).toEqual({ kind: "assemblyai-sync", options: {} });
  });

  test("reads the sandbox key by default", () => {
    expect(ASSEMBLYAI_SYNC_API_KEY_ENV).toBe("ASSEMBLYAI_API_KEY_SANDBOX");
  });
});

describe("resolveAssemblyAISyncSttSettings", () => {
  test("fills every default and omits an unset prompt", () => {
    expect(resolveAssemblyAISyncSttSettings({})).toEqual({
      url: ASSEMBLYAI_SYNC_DEFAULT_URL,
      model: ASSEMBLYAI_SYNC_DEFAULT_MODEL,
      minTurnSilenceMs: ASSEMBLYAI_SYNC_DEFAULT_MIN_TURN_SILENCE_MS,
      speechThresholdDbfs: ASSEMBLYAI_SYNC_DEFAULT_SPEECH_THRESHOLD_DBFS,
      partialIntervalMs: ASSEMBLYAI_SYNC_DEFAULT_PARTIAL_INTERVAL_MS,
    });
  });

  test("keeps explicit values, including a 0 that disables interims", () => {
    expect(
      resolveAssemblyAISyncSttSettings({
        url: "https://sync.example.test/v1/transcribe",
        model: "m",
        prompt: "p",
        minTurnSilenceMs: 300,
        speechThresholdDbfs: -40,
        partialIntervalMs: 0,
      }),
    ).toEqual({
      url: "https://sync.example.test/v1/transcribe",
      model: "m",
      prompt: "p",
      minTurnSilenceMs: 300,
      speechThresholdDbfs: -40,
      partialIntervalMs: 0,
    });
  });
});
