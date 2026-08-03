// Copyright 2025 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai/tts` subpath barrel.
 *
 * Re-exports the descriptor factories (`assemblyAITts`, `cartesia`, `rime`)
 * and the shared TTS contract types. Does not pull in any provider SDK — the
 * host resolver handles that at session start.
 *
 * Named re-exports rather than `export *`: the wildcard form needs a
 * `noReExportAll` suppression per line, and the escape-hatch ratchet only
 * moves down. Listing them also makes the public surface of this subpath
 * readable in one place — add new symbols here when a provider gains one.
 *
 * @module tts
 */

export type {
  TtsError,
  TtsEvents,
  TtsOpenOptions,
  TtsProvider,
  TtsSession,
  Unsubscribe,
} from "../providers.ts";
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
} from "./tts/assemblyai.ts";
export {
  CARTESIA_API_KEY_ENV,
  CARTESIA_DEFAULT_VOICE,
  CARTESIA_KIND,
  type CartesiaOptions,
  type CartesiaProvider,
  cartesia,
} from "./tts/cartesia.ts";
export {
  RIME_API_KEY_ENV,
  RIME_DEFAULT_VOICE,
  RIME_KIND,
  type RimeOptions,
  type RimeProvider,
  rime,
} from "./tts/rime.ts";
