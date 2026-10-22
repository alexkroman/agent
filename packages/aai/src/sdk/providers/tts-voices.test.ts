// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
import type { KnownLiterals } from "../is-known.ts";
import {
  ASSEMBLYAI_TTS_DEFAULT_VOICE,
  ASSEMBLYAI_TTS_VOICES,
  type AssemblyAITtsVoice,
  isCatalogVoice,
} from "./tts-voices.ts";

describe("ASSEMBLYAI_TTS_VOICES", () => {
  test("the catalog and the open voice type's literals are one list", () => {
    // Spelled twice (the tuple and `AssemblyAITtsVoice`) so neither publishes a
    // closed union; this is what keeps the two copies equal.
    expectTypeOf<(typeof ASSEMBLYAI_TTS_VOICES)[number]>().toEqualTypeOf<
      KnownLiterals<AssemblyAITtsVoice>
    >();
  });

  test("every entry is a library slug, the only form the service takes", () => {
    // A bare name (`jane`) is refused with 3012; the retired `voice` param took them.
    for (const voice of ASSEMBLYAI_TTS_VOICES) expect(voice).toMatch(/^aai-[a-z]+$/);
  });

  test("is what z.enum takes, for a form that offers a voice", () => {
    expect(z.enum(ASSEMBLYAI_TTS_VOICES).parse("aai-vera")).toBe("aai-vera");
  });
});

describe("isCatalogVoice", () => {
  test("answers for the listed slugs only — not a bare name, not a prototype key", () => {
    expect(isCatalogVoice("aai-jane")).toBe(true);
    expect(isCatalogVoice("jane")).toBe(false);
    expect(isCatalogVoice("toString")).toBe(false);
  });
});

describe("ASSEMBLYAI_TTS_DEFAULT_VOICE", () => {
  test("is a voice the catalog lists", () => {
    expect(isCatalogVoice(ASSEMBLYAI_TTS_DEFAULT_VOICE)).toBe(true);
  });
});
