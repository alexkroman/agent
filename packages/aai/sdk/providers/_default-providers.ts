// Copyright 2026 the AAI authors. MIT license.
/**
 * Internal: the default-provider rule behind the pipeline-by-default flip.
 * Not part of the public API — user-facing entry points are
 * `assemblyAIPipeline()` (the preset) and `assemblyAIS2s()` (the S2S opt-in).
 */

import type { LlmProvider, SttProvider, TtsProvider } from "../providers.ts";
import { assemblyAIPipeline } from "./assemblyai-pipeline.ts";

/** The four provider-descriptor fields a config can declare, plus the text opt-in. */
type ProviderFields = {
  stt?: unknown;
  llm?: unknown;
  tts?: unknown;
  s2s?: unknown;
  text?: unknown;
};

/**
 * The default providers for the pipeline stages a config leaves unset: each
 * missing stage of the `stt`/`llm`/`tts` triple is filled from the
 * all-AssemblyAI pipeline. Returns only the missing stages (spread it over
 * the config), or `null` when there is nothing to fill — every stage is
 * declared, `s2s` is set (an explicit `s2s` descriptor is exactly how an
 * agent opts into S2S mode, and it takes no pipeline stages), or `text` is
 * set (a text agent has no audio stages to fill — its `llm` is defaulted by
 * `createTextAgent` instead, since that is the only stage it has).
 *
 * A declared stage is never overridden, so
 * `agent({ llm: anthropicLlm(...) })` means "the default pipeline with that
 * LLM" — one stage swapped, the other two on AssemblyAI — rather than a
 * configuration error. Before this, the triple was all-or-nothing and the
 * only way to swap one stage was spreading `assemblyAIPipeline()` first.
 *
 * Every config layer that derives a session mode applies this first —
 * `toAgentConfig` and the runtime's provider resolution — so "no providers"
 * means the pipeline everywhere, never S2S by fallthrough
 * (see "Never let S2S be a fallback" in `packages/aai/CLAUDE.md`).
 */
export function defaultProviders(config: ProviderFields): {
  stt?: SttProvider;
  llm?: LlmProvider;
  tts?: TtsProvider;
} | null {
  if (config.s2s != null || config.text === true) return null;
  if (config.stt != null && config.llm != null && config.tts != null) return null;
  const pipeline = assemblyAIPipeline();
  const fill: {
    stt?: SttProvider;
    llm?: LlmProvider;
    tts?: TtsProvider;
  } = {};
  if (config.stt == null) fill.stt = pipeline.stt;
  if (config.llm == null) fill.llm = pipeline.llm;
  if (config.tts == null) fill.tts = pipeline.tts;
  return fill;
}
