// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import {
  DEFAULT_MAX_TURN_SILENCE_MS,
  DEFAULT_MIN_TURN_SILENCE_MS,
} from "../../endpointing-constants.ts";
import {
  DEFAULT_VAD_THRESHOLD,
  DEFAULT_VOICE_FOCUS,
  DEFAULT_VOICE_FOCUS_THRESHOLD,
  STT_CONNECT_MAX_RETRIES,
  STT_CONNECT_TIMEOUT_MS,
} from "../../pipeline-tuning-constants.ts";
import {
  ASSEMBLYAI_STT_API_KEY_ENV,
  ASSEMBLYAI_STT_DEFAULT_LANGUAGES,
  ASSEMBLYAI_STT_DEFAULT_MODEL,
  ASSEMBLYAI_STT_KIND,
  assemblyAIStt,
  isUniversal35Pro,
  resolveAssemblyAISttSettings,
} from "./assemblyai.ts";

describe("assemblyAIStt", () => {
  test("is an assemblyai descriptor carrying the options as given, with no defaults", () => {
    expect(ASSEMBLYAI_STT_KIND).toBe("assemblyai");
    expect(ASSEMBLYAI_STT_API_KEY_ENV).toBe("ASSEMBLYAI_API_KEY");
    expect(assemblyAIStt()).toEqual({ kind: "assemblyai", options: {} });
    expect(assemblyAIStt({ region: "eu" }).options).toEqual({ region: "eu" });
  });
});

describe("resolveAssemblyAISttSettings", () => {
  test("fills every unset knob with its default, and adds no other optional key", () => {
    expect(resolveAssemblyAISttSettings({})).toEqual({
      model: ASSEMBLYAI_STT_DEFAULT_MODEL,
      languages: ASSEMBLYAI_STT_DEFAULT_LANGUAGES,
      minTurnSilenceMs: DEFAULT_MIN_TURN_SILENCE_MS,
      maxTurnSilenceMs: DEFAULT_MAX_TURN_SILENCE_MS,
      voiceFocus: DEFAULT_VOICE_FOCUS,
      voiceFocusThreshold: DEFAULT_VOICE_FOCUS_THRESHOLD,
      vadThreshold: DEFAULT_VAD_THRESHOLD,
      connectTimeoutMs: STT_CONNECT_TIMEOUT_MS,
      maxConnectRetries: STT_CONNECT_MAX_RETRIES,
    });
  });

  test("carries an explicit vadThreshold, and defaults it to DEFAULT_VAD_THRESHOLD", () => {
    expect(resolveAssemblyAISttSettings({ vadThreshold: 0.2 }).vadThreshold).toBe(0.2);
    expect(resolveAssemblyAISttSettings({}).vadThreshold).toBe(DEFAULT_VAD_THRESHOLD);
  });

  test('`voiceFocus: "off"` sends no focus at all', () => {
    expect(resolveAssemblyAISttSettings({ voiceFocus: "off" }).voiceFocus).toBe("");
  });

  test("defaults languages to English only", () => {
    expect(ASSEMBLYAI_STT_DEFAULT_LANGUAGES).toEqual(["en"]);
    expect(Object.isFrozen(ASSEMBLYAI_STT_DEFAULT_LANGUAGES)).toBe(true);
    expect(resolveAssemblyAISttSettings({}).languages).toEqual(["en"]);
  });

  test("passes an explicit language list through exactly as given", () => {
    const several = ["en", "es"] as const;
    expect(resolveAssemblyAISttSettings({ languages: several }).languages).toBe(several);
    expect(resolveAssemblyAISttSettings({ languages: ["fr"] }).languages).toEqual(["fr"]);
  });

  test("an empty language list opts out of the default: nothing is sent, so the model code-switches", () => {
    const settings = resolveAssemblyAISttSettings({ languages: [], streamingUrl: "" });
    expect("languages" in settings).toBe(false);
    expect("streamingUrl" in settings).toBe(false);
  });

  test("keeps every knob the author set", () => {
    expect(
      resolveAssemblyAISttSettings({
        model: "u3-rt-pro",
        languages: ["en", "es"],
        streamingUrl: "wss://example/ws",
        region: "eu",
        formatTurns: false,
        minTurnSilenceMs: 800,
        maxTurnSilenceMs: 4000,
      }),
    ).toMatchObject({
      model: "u3-rt-pro",
      languages: ["en", "es"],
      streamingUrl: "wss://example/ws",
      region: "eu",
      formatTurns: false,
      minTurnSilenceMs: 800,
      maxTurnSilenceMs: 4000,
    });
  });
});

describe("isUniversal35Pro", () => {
  test.each(["universal-3-5-pro", "u3-rt-pro", "u3-rt-agent"])("recognises %s", (model) => {
    expect(isUniversal35Pro(model)).toBe(true);
  });

  test.each(["universal-streaming", "nova-3", ""])("does not claim %j", (model) => {
    expect(isUniversal35Pro(model)).toBe(false);
  });
});
