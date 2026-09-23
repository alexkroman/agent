// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, expectTypeOf, test } from "vitest";
import type { KnownLiterals } from "../is-known.ts";
import {
  ASSEMBLYAI_TTS_DEFAULT_VOICE,
  type ASSEMBLYAI_TTS_VOICES,
  type AssemblyAITtsVoice,
  ttsVoiceInfo,
} from "./tts-voices.ts";

describe("ttsVoiceInfo", () => {
  test("answers a listed voice's row, and undefined for one the catalog does not list", () => {
    expect(ttsVoiceInfo("estelle")).toEqual({ language: "fr", accent: "FR" });
    expect(ttsVoiceInfo("a-voice-shipped-next-week")).toBeUndefined();
  });

  test("reads OWN keys only, so a prototype name is not a voice", () => {
    expect(ttsVoiceInfo("toString")).toBeUndefined();
    expect(ttsVoiceInfo("constructor")).toBeUndefined();
  });

  test("the catalog's keys and the open voice type's literals are one list", () => {
    // Spelled twice (the map's annotation and `AssemblyAITtsVoice`) so neither
    // publishes a closed union; this is what keeps the two copies equal.
    expectTypeOf<keyof typeof ASSEMBLYAI_TTS_VOICES>().toEqualTypeOf<
      KnownLiterals<AssemblyAITtsVoice>
    >();
  });
});

describe("ASSEMBLYAI_TTS_DEFAULT_VOICE", () => {
  test("is a voice the catalog lists", () => {
    expect(ttsVoiceInfo(ASSEMBLYAI_TTS_DEFAULT_VOICE)).toBeDefined();
  });
});
