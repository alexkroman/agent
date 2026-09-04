// Copyright 2025 the AAI authors. MIT license.
/**
 * Capability contract: `tts`.
 *
 * Pipeline-mode text-to-speech provider descriptors, and the AssemblyAI voice
 * catalog an author picks from.
 *
 * `ProviderDescriptor` is the `agent` capability's — see `stt.ts` for why.
 * `TtsProvider` stays here, published on the root as well but owned by the narrower
 * subpath. `ASSEMBLYAI_TTS_VOICES` and `AssemblyAITtsVoice` stay here
 * even though the root barrel publishes them too: this is the narrower
 * subpath, and the rule is that a name published on both belongs to the
 * narrower one.
 *
 * Re-exported from `@alexkroman1/aai/tts`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  ASSEMBLYAI_TTS_DEFAULT_VOICE,
  ASSEMBLYAI_TTS_LANGUAGES,
  ASSEMBLYAI_TTS_VOICES,
  type AssemblyAITtsLanguage,
  type AssemblyAITtsOptions,
  type AssemblyAITtsVoice,
  type AssemblyAITtsVoiceId,
  type AssemblyAITtsVoiceInfo,
  assemblyAITts,
  CARTESIA_DEFAULT_VOICE,
  type CartesiaTtsOptions,
  cartesiaTts,
  RIME_DEFAULT_VOICE,
  type RimeTtsOptions,
  rimeTts,
  type TtsProvider,
} from "../../sdk/providers/tts-barrel.ts";
