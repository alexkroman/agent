// Copyright 2025 the AAI authors. MIT license.
/**
 * Frozen authoring example: `tts` epoch 1.
 *
 * See `../agent/v1.ts` for what "frozen" obliges and why the imports are
 * relative.
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
  RIME_API_KEY_ENV,
  RIME_DEFAULT_VOICE,
  RIME_KIND,
  rime,
  type TtsError,
  type TtsEvents,
  type TtsOpenOptions,
  type TtsProvider,
  type TtsSession,
  type TtsWordTiming,
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

/** The host-side session contract a custom opener implements against. */
export type FixtureOpener = (options: TtsOpenOptions) => Promise<TtsSession>;
export type FixtureEvents = TtsEvents;
export type FixtureWordTiming = TtsWordTiming;
export type FixtureError = TtsError;
