// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:tts` epoch 3.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 *
 * Epoch 3 is epoch 2 minus eleven symbols an author never typed: the six
 * `*_KIND`/`*_API_KEY_ENV` constants and the 21-element
 * `ASSEMBLYAI_TTS_DEPRECATED_VOICES` tuple (to
 * `@alexkroman1/aai/host-internal` — the retired list answers "is this name
 * real?", which is the template gate's question, not an author's), the three
 * narrowed `*Provider` aliases, and `ProviderDescriptor` to the ROOT barrel.
 *
 * The voice catalog is unchanged and is the point of the subpath: an
 * unrecognised id has no authoring-time symptom, and
 * {@link ASSEMBLYAI_TTS_VOICES} is the only checkable list. It is on the root
 * barrel too now, because `agent({ voice })` is typed against it.
 */

import {
  ASSEMBLYAI_TTS_DEFAULT_VOICE,
  ASSEMBLYAI_TTS_LANGUAGES,
  ASSEMBLYAI_TTS_VOICES,
  type AssemblyAITtsLanguage,
  type AssemblyAITtsOptions,
  type AssemblyAITtsVoice,
  assemblyAITts,
  CARTESIA_DEFAULT_VOICE,
  cartesia,
  RIME_DEFAULT_VOICE,
  rime,
  type TtsProvider,
} from "../../../sdk/providers/tts-barrel.ts";

/** A voice is picked from the published catalog, never invented. */
export const voice: AssemblyAITtsVoice = ASSEMBLYAI_TTS_DEFAULT_VOICE;
export const language: AssemblyAITtsLanguage = "en";
export const languageLabel: string = ASSEMBLYAI_TTS_LANGUAGES[language];

export const options: AssemblyAITtsOptions = {
  voice,
  language,
  apiKeyEnv: "ASSEMBLYAI_STAGING_KEY",
};
export const assemblyai: TtsProvider = assemblyAITts(options);

export const alternatives: TtsProvider[] = [
  cartesia({ voice: CARTESIA_DEFAULT_VOICE, model: "sonic-3", language: "en" }),
  rime({ voice: RIME_DEFAULT_VOICE, model: "mistv2", language: "eng" }),
];

/** The catalog is keyed by voice name, with the accent alongside each. */
export const catalog: string[] = Object.keys(ASSEMBLYAI_TTS_VOICES);
export const accent: string = ASSEMBLYAI_TTS_VOICES.alba.accent;

export const kinds: string[] = [assemblyai.kind, ...alternatives.map((p) => p.kind)];
