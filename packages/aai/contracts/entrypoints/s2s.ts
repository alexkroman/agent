// Copyright 2025 the AAI authors. MIT license.
/**
 * Capability contract: `s2s`.
 *
 * Speech-to-speech provider descriptors.
 *
 * `ProviderDescriptor` is the `agent` capability's — see `stt.ts` for why.
 * `S2sProvider` stays here, published on the root as well but owned by the narrower
 * subpath.
 *
 * Re-exported from `@alexkroman1/aai/s2s`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  type AssemblyAIS2sOptions,
  assemblyAIS2s,
  type OpenAIS2sOptions,
  type OpenAIS2sVoice,
  openaiS2s,
  type S2sProvider,
} from "../../sdk/providers/s2s-barrel.ts";
