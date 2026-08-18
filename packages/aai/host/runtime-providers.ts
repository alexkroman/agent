// Copyright 2026 the AAI authors. MIT license.
/**
 * Which providers a runtime actually runs, and therefore which session mode.
 *
 * Split out of `runtime.ts` at the 500-line cap, and it is the leaf that file
 * had: a pure function of `(RuntimeOptions, AgentDef)` that closes over nothing,
 * where everything else in `runtime.ts` is about owning per-session transports.
 * The rule it encodes — a config that loses its providers gets the AssemblyAI
 * pipeline, never a silent S2S session — is stated once here and mirrored in
 * `runtime-transport.ts`.
 */

import { assertProviderTriple, type SessionMode } from "../sdk/config-rules.ts";
import { defaultProviders } from "../sdk/providers/_default-providers.ts";
import type { LlmProvider, SttProvider, TtsProvider } from "../sdk/providers.ts";
import type { AgentDef } from "../sdk/types.ts";
import type { RuntimeOptions } from "./runtime-types.ts";
import { textAgentHasNoSession } from "./text-agent.ts";

/**
 * Determine the effective STT/LLM/TTS providers and session mode. Providers
 * come from RuntimeOptions (platform path) or fall back to the agent's own
 * fields (the `aai dev` path passes no provider opts), so a declared pipeline
 * agent isn't silently downgraded to S2S.
 */
export function resolveEffectiveProviders(
  opts: RuntimeOptions,
  agent: AgentDef,
): {
  stt: SttProvider | undefined;
  llm: LlmProvider | undefined;
  tts: TtsProvider | undefined;
  s2s: AgentDef["s2s"];
  /** Never `"text"` — a text agent is refused below, before any of this. */
  mode: Exclude<SessionMode, "text">;
} {
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
  if (agent.text === true) throw textAgentHasNoSession(agent.name);
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
