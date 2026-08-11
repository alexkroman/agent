// Copyright 2026 the AAI authors. MIT license.
/**
 * Provider and session-mode resolution for the agent runtime.
 *
 * Answers "which STT/LLM/TTS does this runtime actually run, and in which
 * mode" — one step ahead of `runtime-transport.ts`, which turns that answer
 * into a per-session `Transport`. Split out of `runtime.ts` so that module is
 * about owning sessions rather than about deciding what they talk to.
 */

import { assertProviderTriple, type SessionMode } from "../sdk/config-rules.ts";
import { defaultProviders } from "../sdk/providers/_default-providers.ts";
import type { LlmProvider, SttProvider, TtsProvider } from "../sdk/providers.ts";
import type { AgentDef } from "../sdk/types.ts";
import { resolveLlm, resolveStt, resolveTts } from "./providers/resolve.ts";
import type { ResolvedPipelineProviders } from "./runtime-transport.ts";
import type { RuntimeOptions } from "./runtime-types.ts";

/** The descriptors and mode one runtime resolved for itself. */
export type EffectiveProviders = {
  stt: SttProvider | undefined;
  llm: LlmProvider | undefined;
  tts: TtsProvider | undefined;
  s2s: AgentDef["s2s"];
  mode: SessionMode;
};

/**
 * Determine the effective STT/LLM/TTS providers and session mode. Providers
 * come from RuntimeOptions (platform path) or fall back to the agent's own
 * fields (the `aai dev` path passes no provider opts), so a declared pipeline
 * agent isn't silently downgraded to S2S.
 *
 * @internal
 */
export function resolveEffectiveProviders(
  opts: RuntimeOptions,
  agent: AgentDef,
): EffectiveProviders {
  const stt = opts.stt ?? agent.stt;
  const llm = opts.llm ?? agent.llm;
  const tts = opts.tts ?? agent.tts;
  // A full provider triple passed as RuntimeOptions replaces the agent's
  // session-mode declaration entirely, `s2s` field included — the platform
  // path uses opts as an override, not a merge.
  const s2s = stt && llm && tts ? undefined : agent.s2s;
  // Pipeline stages not declared anywhere → filled from the all-AssemblyAI
  // pipeline, matching toAgentConfig. S2S requires an explicit
  // `s2s` descriptor (`assemblyAIS2s()`), so a config that loses its
  // providers can no longer silently run S2S — this mirrors, not replaces,
  // the "never let S2S be a fallback" rule in runtime-transport.ts.
  const defaults = defaultProviders({ stt, llm, tts, s2s });
  if (defaults) {
    return {
      stt: stt ?? defaults.stt,
      llm: llm ?? defaults.llm,
      tts: tts ?? defaults.tts,
      s2s: undefined,
      mode: "pipeline",
    };
  }
  return { stt, llm, tts, s2s, mode: assertProviderTriple(stt, llm, tts, s2s) };
}

/**
 * Resolve the three pipeline provider instances once per runtime (reused
 * across sessions). Returns null unless the mode is pipeline and all three
 * providers are present.
 *
 * @internal
 */
export function resolvePipelineProviders(
  p: Pick<EffectiveProviders, "mode" | "stt" | "llm" | "tts">,
  env: Record<string, string>,
): ResolvedPipelineProviders | null {
  if (p.mode !== "pipeline" || !(p.stt && p.llm && p.tts)) return null;
  // The STT/TTS env vars travel with their openers, so nothing downstream has
  // to keep the raw descriptors around just to re-derive a credential.
  return {
    stt: resolveStt(p.stt),
    llm: resolveLlm(p.llm, env),
    tts: resolveTts(p.tts),
  };
}
