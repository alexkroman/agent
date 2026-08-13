// Copyright 2025 the AAI authors. MIT license.
/**
 * Capability contract: `s2s`.
 *
 * Speech-to-speech provider descriptors.
 *
 * Re-exported from `@alexkroman1/aai/s2s`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  ASSEMBLYAI_S2S_API_KEY_ENV,
  ASSEMBLYAI_S2S_KIND,
  type AssemblyAIS2sOptions,
  type AssemblyAIS2sProvider,
  assemblyAIS2s,
  OPENAI_REALTIME_API_KEY_ENV,
  OPENAI_REALTIME_KIND,
  type OpenaiRealtimeOptions,
  type OpenaiRealtimeProvider,
  type OpenaiRealtimeVoice,
  openaiRealtime,
  type S2sProvider,
} from "../../sdk/providers/s2s-barrel.ts";
