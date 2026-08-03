// Copyright 2026 the AAI authors. MIT license.
/**
 * Internal: the default-provider rule behind the pipeline-by-default flip.
 * Not part of the public API — user-facing entry points are
 * `assemblyAIPipeline()` (the preset) and `assemblyAIS2s()` (the S2S opt-in).
 */

import { assemblyAIPipeline } from "./assemblyai-pipeline.ts";
import type { AssemblyAILlmProvider } from "./llm/assemblyai.ts";
import type { AssemblyAIProvider } from "./stt/assemblyai.ts";
import type { AssemblyAITtsProvider } from "./tts/assemblyai.ts";

/** The four provider-descriptor fields a config can declare. */
type ProviderFields = {
  stt?: unknown;
  llm?: unknown;
  tts?: unknown;
  s2s?: unknown;
};

/**
 * The default providers for a config that declares none: the all-AssemblyAI
 * pipeline. Returns `null` when any provider field (the pipeline triple or
 * `s2s`) is already set — a declared choice is never overridden, and an
 * explicit `s2s` descriptor is exactly how an agent opts back into S2S mode.
 *
 * Every config layer that derives a session mode applies this first —
 * `parseManifest`, `toAgentConfig`, and the runtime's provider resolution —
 * so "no providers" means the pipeline everywhere, never S2S by fallthrough
 * (see "Never let S2S be a fallback" in CLAUDE.md).
 */
export function defaultProviders(config: ProviderFields): {
  stt: AssemblyAIProvider;
  llm: AssemblyAILlmProvider;
  tts: AssemblyAITtsProvider;
} | null {
  const declared =
    config.stt != null || config.llm != null || config.tts != null || config.s2s != null;
  return declared ? null : assemblyAIPipeline();
}
