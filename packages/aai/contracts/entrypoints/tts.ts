// Copyright 2025 the AAI authors. MIT license.
/**
 * Capability contract: `tts`.
 *
 * Pipeline-mode text-to-speech provider descriptors.
 *
 * Re-exported from `@alexkroman1/aai/tts`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  ASSEMBLYAI_TTS_API_KEY_ENV,
  ASSEMBLYAI_TTS_DEFAULT_VOICE,
  ASSEMBLYAI_TTS_DEPRECATED_VOICES,
  ASSEMBLYAI_TTS_KIND,
  ASSEMBLYAI_TTS_LANGUAGES,
  ASSEMBLYAI_TTS_VOICES,
  type AssemblyAITtsLanguage,
  type AssemblyAITtsOptions,
  type AssemblyAITtsProvider,
  type AssemblyAITtsVoice,
  assemblyAITts,
  CARTESIA_API_KEY_ENV,
  CARTESIA_DEFAULT_VOICE,
  CARTESIA_KIND,
  type CartesiaOptions,
  type CartesiaProvider,
  cartesia,
  RIME_API_KEY_ENV,
  RIME_DEFAULT_VOICE,
  RIME_KIND,
  type RimeOptions,
  type RimeProvider,
  rime,
  type TtsProvider,
} from "../../sdk/providers/tts-barrel.ts";
