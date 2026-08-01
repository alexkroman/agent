// Copyright 2025 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai/tts` subpath barrel.
 *
 * Re-exports the descriptor factories (`assemblyAI`, `cartesia`, `rime`) and
 * the shared TTS contract types. Does not pull in any provider SDK — the host
 * resolver handles that at session start.
 *
 * Named re-exports rather than `export *`: the wildcard form needs a
 * `noReExportAll` suppression per line, and the escape-hatch ratchet only
 * moves down. Listing them also makes the public surface of this subpath
 * readable in one place — add new symbols here when a provider gains one.
 */

export type { TtsError, TtsEvents, TtsOpenOptions, TtsProvider, TtsSession } from "../providers.ts";
export {
  ASSEMBLYAI_TTS_API_KEY_ENV,
  type AssemblyAITtsOptions,
  type AssemblyAITtsProvider,
  assemblyAI,
} from "./tts/assemblyai.ts";
export {
  CARTESIA_API_KEY_ENV,
  type CartesiaOptions,
  type CartesiaProvider,
  cartesia,
} from "./tts/cartesia.ts";
export {
  RIME_API_KEY_ENV,
  type RimeOptions,
  type RimeProvider,
  rime,
} from "./tts/rime.ts";
