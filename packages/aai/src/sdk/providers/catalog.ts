// Copyright 2026 the AAI authors. MIT license.
/**
 * The provider CATALOG — every vendor this release ships, one
 * {@link ProviderDefinition} each, per stage.
 *
 * The STT, TTS and S2S definitions live in their vendor's module beside the
 * factory that stamps them; the LLM stage has one factory (`llm()`) for every
 * vendor, so its definitions are here, held total against `KnownLlmProvider`
 * by the `satisfies` below. What reads this list:
 *
 * - `aai-runtime`'s `providers/registry.ts`, whose per-stage opener tables are
 *   typed `Record<…Kind, …>` over these kinds — a vendor added here and not
 *   given an opener there is a compile error, and `registry.test.ts` checks
 *   the converse at run time (no opener for a kind the catalog lacks);
 * - `scripts/sync-provider-table.mjs`, which writes the docs site's
 *   provider table from it (`check:provider-table` fails when it is stale).
 *
 * @module
 */

import { defineProvider, type ProviderDefinition } from "./define-provider.ts";
import { ASSEMBLYAI_LLM_PROVIDER } from "./llm/assemblyai.ts";
import type { KnownLlmProvider } from "./llm/llm.ts";
import { ASSEMBLYAI_S2S_PROVIDER } from "./s2s/assemblyai.ts";
import { OPENAI_S2S_PROVIDER } from "./s2s/openai.ts";
import { ASSEMBLYAI_STT_PROVIDER } from "./stt/assemblyai.ts";
import { DEEPGRAM_PROVIDER } from "./stt/deepgram.ts";
import { ELEVENLABS_STT_PROVIDER } from "./stt/elevenlabs.ts";
import { LOCAL_STT_PROVIDER } from "./stt/local.ts";
import { SONIOX_PROVIDER } from "./stt/soniox.ts";
import { ASSEMBLYAI_TTS_PROVIDER } from "./tts/assemblyai.ts";
import { CARTESIA_PROVIDER } from "./tts/cartesia.ts";
import { RIME_PROVIDER } from "./tts/rime.ts";

/** An LLM definition, spelled the way `llm()` is called. */
function llmProvider<const Kind extends string>(
  kind: Kind,
  envVar: string,
  label: string,
): ProviderDefinition<Kind, "llm"> {
  return defineProvider({
    kind,
    stage: "llm",
    envVar,
    label,
    factory: `llm({ provider: "${kind}" })`,
    subpath: "llm",
  });
}

/** The STT vendors, in the order the docs table lists them. */
export const STT_PROVIDERS = [
  ASSEMBLYAI_STT_PROVIDER,
  DEEPGRAM_PROVIDER,
  ELEVENLABS_STT_PROVIDER,
  SONIOX_PROVIDER,
  LOCAL_STT_PROVIDER,
] as const;

/** The TTS vendors, in the order the docs table lists them. */
export const TTS_PROVIDERS = [ASSEMBLYAI_TTS_PROVIDER, CARTESIA_PROVIDER, RIME_PROVIDER] as const;

/** The S2S vendors. */
export const S2S_PROVIDERS = [ASSEMBLYAI_S2S_PROVIDER, OPENAI_S2S_PROVIDER] as const;

/**
 * The LLM vendors with a built-in resolver, keyed by `llm({ provider })` —
 * TOTAL over `KnownLlmProvider`, so a literal added to `LlmProviderName` is a
 * compile error here until it has a key variable.
 *
 * The base URLs and `@ai-sdk/*` clients stay in `aai-runtime`'s
 * `providers/_llm-registry.ts`, beside the client they configure; the gateway
 * endpoints alone are in the SDK, because `stepGenerate` dials them.
 */
export const LLM_PROVIDERS = {
  anthropic: llmProvider("anthropic", "ANTHROPIC_API_KEY", "Anthropic"),
  openai: llmProvider("openai", "OPENAI_API_KEY", "OpenAI"),
  google: llmProvider("google", "GOOGLE_GENERATIVE_AI_API_KEY", "Google"),
  mistral: llmProvider("mistral", "MISTRAL_API_KEY", "Mistral"),
  xai: llmProvider("xai", "XAI_API_KEY", "xAI"),
  groq: llmProvider("groq", "GROQ_API_KEY", "Groq"),
  openrouter: llmProvider("openrouter", "OPENROUTER_API_KEY", "OpenRouter"),
  cerebras: llmProvider("cerebras", "CEREBRAS_API_KEY", "Cerebras"),
  gateway: llmProvider("gateway", "AI_GATEWAY_API_KEY", "Vercel AI Gateway"),
  assemblyai: ASSEMBLYAI_LLM_PROVIDER,
} as const satisfies { [K in KnownLlmProvider]: ProviderDefinition<K, "llm"> };

/** A catalog kind at one stage — the key set an opener table must cover. */
export type SttKind = (typeof STT_PROVIDERS)[number]["kind"];
/** @see {@link SttKind} */
export type TtsKind = (typeof TTS_PROVIDERS)[number]["kind"];
/** @see {@link SttKind} */
export type S2sKind = (typeof S2S_PROVIDERS)[number]["kind"];

/**
 * Every definition, stage by stage — the docs table's rows, in order.
 *
 * @internal
 */
export const PROVIDER_CATALOG: readonly ProviderDefinition[] = [
  ...STT_PROVIDERS,
  ...TTS_PROVIDERS,
  ...Object.values(LLM_PROVIDERS),
  ...S2S_PROVIDERS,
];
