// Copyright 2025 the AAI authors. MIT license.
/**
 * Capability contract: `stt`.
 *
 * Pipeline-mode speech-to-text provider descriptors.
 *
 * Re-exported from `@alexkroman1/aai/stt`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  ASSEMBLYAI_API_KEY_ENV,
  ASSEMBLYAI_KIND,
  ASSEMBLYAI_STREAMING_EU_URL,
  type AssemblyAIOptions,
  type AssemblyAIProvider,
  assemblyAIStt,
  DEEPGRAM_API_KEY_ENV,
  DEEPGRAM_KIND,
  DEFAULT_DEEPGRAM_ENDPOINTING_MS,
  type DeepgramOptions,
  type DeepgramProvider,
  deepgram,
  ELEVENLABS_API_KEY_ENV,
  ELEVENLABS_KIND,
  type ElevenLabsOptions,
  type ElevenLabsProvider,
  elevenlabs,
  SONIOX_API_KEY_ENV,
  SONIOX_KIND,
  type SonioxOptions,
  type SonioxProvider,
  type SttProvider,
  soniox,
} from "../../sdk/providers/stt-barrel.ts";
