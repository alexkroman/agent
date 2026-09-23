// Copyright 2025 the AAI authors. MIT license.
/**
 * Capability contract: `llm`.
 *
 * Pipeline-mode LLM provider descriptors: ONE factory, `llm()`, whose
 * `provider` is data rather than a function name.
 *
 * `ProviderDescriptor` is the `agent` capability's — see `stt.ts` for why.
 * `LlmProvider` stays here, published on the root as well but owned by the narrower
 * subpath. The gateway CATALOG (`ASSEMBLYAI_GATEWAY_MODELS`,
 * `GatewayModelInfo`, `gatewayModelIds`) is on
 * `@alexkroman1/aai/host-internal`, which is not contracted: it is generated
 * from the service on whatever afternoon someone regenerates it, and hashing
 * a generated data table made routine ops a classification decision.
 * The id snapshot it produces IS contracted here, as the literals spelled
 * inline in the open `AssemblyAIGatewayModel` (`"gpt-5" | … | (string & {})`).
 * That spelling is what makes a regeneration a REVISION rather than an epoch:
 * the open type accepts every string before and after, so the probe proves it
 * mutually assignable. It was NOT true while the literals sat in an exported
 * closed `KnownGatewayModel` beside it — that union changed what it accepted
 * on every regeneration, and so could never be proven compatible. It and
 * `KnownLlmProvider` (the same shape for `LlmProviderName`) are on
 * `@alexkroman1/aai/host-internal` now, which is not contracted.
 *
 * Neither the providers' key variables nor their base URLs are here: both
 * live in the host resolver's table (`aai-runtime`'s
 * `providers/_llm-registry.ts`).
 *
 * Re-exported from `@alexkroman1/aai/llm`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  ASSEMBLYAI_LLM_DEFAULT_MODEL,
  type AssemblyAIGatewayModel,
  type AssemblyAILlmProviderOptions,
  type AssemblyAIReasoningEffort,
  type LlmDescriptorOptions,
  type LlmOptions,
  type LlmProvider,
  type LlmProviderName,
  type LlmSpec,
  llm,
} from "../../sdk/providers/llm-barrel.ts";
