// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `providers`.
 *
 * Registering a speech stage the SDK does not ship, and resolving the LLM
 * a config names. What a custom provider is written against.
 *
 * Re-exported from `@alexkroman1/aai-runtime`. This file is not shipped and
 * nothing imports it — it exists so `pnpm check:api-contracts` can extract a
 * report for this capability alone, hash it, and hold it to a committed epoch.
 * See `scripts/api-contracts.mjs`.
 */

export {
  createToolCallRepair,
  type OpenerRegistryEntry,
  registerSttKind,
  registerTtsKind,
  resolveLlm,
  type S2SConfig,
  type SttError,
  type SttEvents,
  type SttOpener,
  type SttOpenOptions,
  type SttSession,
  type SttTurnMeta,
  salvageJson,
  type TtsError,
  type TtsEvents,
  type TtsOpener,
  type TtsOpenOptions,
  type TtsSession,
  type TtsWordTiming,
  type Unsubscribe,
} from "../../runtime-barrel.ts";
