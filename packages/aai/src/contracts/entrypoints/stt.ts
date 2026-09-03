// Copyright 2025 the AAI authors. MIT license.
/**
 * Capability contract: `stt`.
 *
 * Pipeline-mode speech-to-text provider descriptors.
 *
 * `ProviderDescriptor` is the `agent` capability's now — one interface had
 * four reference pages, one per stage subpath, and the base all four narrow
 * spans every stage. `SttProvider` stays here, published on the root as well but
 * owned by the narrower subpath. The eight `*_KIND`/`*_API_KEY_ENV` constants this used to
 * carry are on `@alexkroman1/aai/host-internal`, which is not contracted —
 * nothing an `agent.ts` writes resolves a credential by variable name.
 *
 * Re-exported from `@alexkroman1/aai/stt`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  ASSEMBLYAI_STT_EU_URL,
  type AssemblyAISttOptions,
  assemblyAIStt,
  DEEPGRAM_DEFAULT_ENDPOINTING_MS,
  type DeepgramSttOptions,
  deepgramStt,
  type ElevenLabsSttOptions,
  elevenLabsStt,
  type SonioxSttOptions,
  type SttProvider,
  sonioxStt,
} from "../../sdk/providers/stt-barrel.ts";
