// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  ASSEMBLYAI_TTS_DEFAULT_VOICE,
  ASSEMBLYAI_TTS_LANGUAGES,
  ASSEMBLYAI_TTS_VOICES,
  type AssemblyAITtsLanguage,
} from "./assemblyai.ts";
import { ttsVoiceIds } from "./assemblyai-voice-ids.ts";

describe("ttsVoiceIds", () => {
  test("with no language, every voice in the catalog, in catalog order", () => {
    expect(ttsVoiceIds()).toEqual(Object.keys(ASSEMBLYAI_TTS_VOICES));
  });

  test("with a language, only the voices that speak it", () => {
    const english = ttsVoiceIds("en");
    expect(english.length).toBeGreaterThan(1);
    for (const id of english) {
      expect(ASSEMBLYAI_TTS_VOICES[id as keyof typeof ASSEMBLYAI_TTS_VOICES]?.language).toBe("en");
    }
    expect(ttsVoiceIds("fr")).toEqual(["estelle"]);
  });

  test("every language the SDK translates has at least one voice — the fallback is dormant", () => {
    // The default-voice fallback exists because the TYPE promises a head; this
    // pins that today no translated language actually reaches it.
    for (const code of Object.keys(ASSEMBLYAI_TTS_LANGUAGES) as AssemblyAITtsLanguage[]) {
      const ids = ttsVoiceIds(code);
      expect(ids.length).toBeGreaterThan(0);
      expect(ASSEMBLYAI_TTS_VOICES[ids[0] as keyof typeof ASSEMBLYAI_TTS_VOICES]?.language).toBe(
        code,
      );
    }
  });

  test("an empty filter falls back to the default voice rather than an empty tuple", () => {
    // No catalog voice speaks a language outside `ASSEMBLYAI_TTS_LANGUAGES`;
    // the cast is what it takes to reach the branch the doc promises.
    expect(ttsVoiceIds("xx" as AssemblyAITtsLanguage)).toEqual([ASSEMBLYAI_TTS_DEFAULT_VOICE]);
  });

  test("is the tuple z.enum takes, so a form renders a SELECT", () => {
    const schema = z.enum(ttsVoiceIds("en"));
    expect(schema.safeParse("jane").success).toBe(true);
    expect(schema.safeParse("estelle").success).toBe(false);
  });
});
