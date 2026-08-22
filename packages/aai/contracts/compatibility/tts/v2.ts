// Copyright 2025 the AAI authors. MIT license.
/**
 * Frozen authoring example: `tts` epoch 2.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 *
 * Epoch 2 is epoch 1 minus the host-side opener contract, which moved to
 * `@alexkroman1/aai-runtime` beside `registerTtsKind`. What is left is the
 * agent author's half: three factories, the voice catalog, and the descriptor
 * they return.
 */

import {
  ASSEMBLYAI_TTS_API_KEY_ENV,
  ASSEMBLYAI_TTS_DEFAULT_VOICE,
  ASSEMBLYAI_TTS_DEPRECATED_VOICES,
  ASSEMBLYAI_TTS_KIND,
  ASSEMBLYAI_TTS_LANGUAGES,
  ASSEMBLYAI_TTS_VOICES,
  type AssemblyAITtsLanguage,
  type AssemblyAITtsVoice,
  assemblyAITts,
  CARTESIA_API_KEY_ENV,
  CARTESIA_DEFAULT_VOICE,
  CARTESIA_KIND,
  cartesia,
  type ProviderDescriptor,
  RIME_API_KEY_ENV,
  RIME_DEFAULT_VOICE,
  RIME_KIND,
  rime,
  type TtsProvider,
} from "../../../sdk/providers/tts-barrel.ts";

/** A voice is picked from the published catalog, never invented. */
export const voice: AssemblyAITtsVoice = ASSEMBLYAI_TTS_DEFAULT_VOICE;
export const language: AssemblyAITtsLanguage = "en";
export const languageLabel: string = ASSEMBLYAI_TTS_LANGUAGES[language];

export const assemblyai = assemblyAITts({
  voice,
  language,
  apiKeyEnv: ASSEMBLYAI_TTS_API_KEY_ENV,
});

export const alternatives: TtsProvider[] = [
  cartesia({ voice: CARTESIA_DEFAULT_VOICE, model: "sonic-3", language: "en" }),
  rime({ voice: RIME_DEFAULT_VOICE, model: "mistv2", language: "eng" }),
];

/** The catalog is keyed by voice name, with the accent alongside each. */
export const catalog: string[] = Object.keys(ASSEMBLYAI_TTS_VOICES);
export const accent: string = ASSEMBLYAI_TTS_VOICES.alba.accent;
export const deprecated: string[] = Object.keys(ASSEMBLYAI_TTS_DEPRECATED_VOICES);

export const kinds: string[] = [ASSEMBLYAI_TTS_KIND, CARTESIA_KIND, RIME_KIND, assemblyai.kind];
export const keyEnvVars: string[] = [
  ASSEMBLYAI_TTS_API_KEY_ENV,
  CARTESIA_API_KEY_ENV,
  RIME_API_KEY_ENV,
];

/** The base every stage descriptor narrows, readable on this subpath. */
export type FixtureBase = ProviderDescriptor<string, Record<string, unknown>>;
export const base: FixtureBase = assemblyai;
