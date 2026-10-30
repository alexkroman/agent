// Copyright 2026 the AAI authors. MIT license.
/** Unit test for the `assemblyAIExperimentalStt()` descriptor and its resolved settings. */

import { describe, expect, test } from "vitest";
import {
  ASSEMBLYAI_EXPERIMENTAL_API_KEY_ENV,
  ASSEMBLYAI_EXPERIMENTAL_DEFAULT_MIN_TURN_SILENCE_MS,
  ASSEMBLYAI_EXPERIMENTAL_DEFAULT_MODEL,
  ASSEMBLYAI_EXPERIMENTAL_DEFAULT_PARTIAL_INTERVAL_MS,
  ASSEMBLYAI_EXPERIMENTAL_DEFAULT_PROMPT,
  ASSEMBLYAI_EXPERIMENTAL_DEFAULT_SPEECH_THRESHOLD_DBFS,
  ASSEMBLYAI_EXPERIMENTAL_DEFAULT_URL,
  ASSEMBLYAI_EXPERIMENTAL_STT_KIND,
  assemblyAIExperimentalStt,
  resolveAssemblyAIExperimentalSttSettings,
} from "./assemblyai-experimental.ts";

describe("assemblyAIExperimentalStt", () => {
  test("returns a pure descriptor that copies its options", () => {
    const options = { model: "m", apiKeyEnv: "MY_KEY" };
    const descriptor = assemblyAIExperimentalStt(options);
    expect(descriptor).toEqual({ kind: ASSEMBLYAI_EXPERIMENTAL_STT_KIND, options });
    expect(descriptor.options).not.toBe(options);
  });

  test("takes no options", () => {
    expect(assemblyAIExperimentalStt()).toEqual({ kind: "assemblyai-experimental", options: {} });
  });

  test("reads the sandbox key by default", () => {
    expect(ASSEMBLYAI_EXPERIMENTAL_API_KEY_ENV).toBe("ASSEMBLYAI_API_KEY_SANDBOX");
  });
});

describe("ASSEMBLYAI_EXPERIMENTAL_DEFAULT_PROMPT", () => {
  test("asks for repeats and spellings verbatim, and never to drop repetitions", () => {
    // "omit … accidental repetitions" deleted real repeated letters ("A, A, R,
    // A, V" -> "AARAB"); see the constant's doc.
    expect(ASSEMBLYAI_EXPERIMENTAL_DEFAULT_PROMPT).not.toMatch(/omit[^.]*repetition/i);
    expect(ASSEMBLYAI_EXPERIMENTAL_DEFAULT_PROMPT).toMatch(/including repeated words/);
    expect(ASSEMBLYAI_EXPERIMENTAL_DEFAULT_PROMPT).toMatch(/Language: English/);
  });
});

describe("resolveAssemblyAIExperimentalSttSettings", () => {
  test("fills every default and omits an unset prompt", () => {
    expect(resolveAssemblyAIExperimentalSttSettings({})).toEqual({
      url: ASSEMBLYAI_EXPERIMENTAL_DEFAULT_URL,
      model: ASSEMBLYAI_EXPERIMENTAL_DEFAULT_MODEL,
      minTurnSilenceMs: ASSEMBLYAI_EXPERIMENTAL_DEFAULT_MIN_TURN_SILENCE_MS,
      speechThresholdDbfs: ASSEMBLYAI_EXPERIMENTAL_DEFAULT_SPEECH_THRESHOLD_DBFS,
      partialIntervalMs: ASSEMBLYAI_EXPERIMENTAL_DEFAULT_PARTIAL_INTERVAL_MS,
    });
  });

  test("keeps explicit values, including a 0 that disables interims", () => {
    expect(
      resolveAssemblyAIExperimentalSttSettings({
        url: "https://transcribe.example.test/v1/transcribe",
        model: "m",
        prompt: "p",
        minTurnSilenceMs: 300,
        speechThresholdDbfs: -40,
        partialIntervalMs: 0,
      }),
    ).toEqual({
      url: "https://transcribe.example.test/v1/transcribe",
      model: "m",
      prompt: "p",
      minTurnSilenceMs: 300,
      speechThresholdDbfs: -40,
      partialIntervalMs: 0,
    });
  });
});
