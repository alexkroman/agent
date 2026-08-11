// Copyright 2026 the AAI authors. MIT license.
/**
 * How a runtime decides WHICH providers it has, and turns them into instances.
 *
 * Split out of `runtime.ts` (the composition root) because it is a self-contained
 * concern with three rules that all needed explaining in one place: the
 * pipeline-by-default fill, the eager resolve that makes a missing credential a
 * BUILD failure rather than a first-session one, and the one exception to that —
 * a static page, below.
 */

import { assertProviderTriple, type SessionMode } from "../sdk/config-rules.ts";
import { defaultProviders } from "../sdk/providers/_default-providers.ts";
import type { LlmProvider, SttProvider, TtsProvider } from "../sdk/providers.ts";
import type { AgentDef } from "../sdk/types.ts";
import { errorMessage } from "../sdk/utils.ts";
import { resolveLlm, resolveStt, resolveTts } from "./providers/resolve.ts";
import type { Logger } from "./runtime-config.ts";
import type { ResolvedPipelineProviders } from "./runtime-transport.ts";
import type { RuntimeOptions } from "./runtime-types.ts";

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
  mode: SessionMode;
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
 */
export function resolvePipelineProviders(
  p: {
    mode: SessionMode;
    stt: SttProvider | undefined;
    llm: LlmProvider | undefined;
    tts: TtsProvider | undefined;
  },
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

/**
 * Resolve providers for a STATIC page, where a failure is NOT fatal.
 *
 * A static app declares no providers, so `defaultProviders` fills the
 * all-AssemblyAI pipeline and resolving it demands `ASSEMBLYAI_API_KEY` — from an
 * app that has no session to spend it on. Eagerly that failed the whole runtime,
 * and for a workflow app the runtime IS the front door (the workflow API is what
 * builds it), so a form-and-a-journal app could not start over a credential it
 * never used.
 *
 * Tolerating the failure rather than SKIPPING resolution is the distinction worth
 * keeping. `page: "static"` is not a promise that no session can ever begin:
 * `createServer` treats it as the default for telephony and not a veto, so an
 * explicit `telephony: true` still routes `/phone`. Skipping left that
 * combination resolving nothing and failing the call at `buildTransport` with
 * "pipeline providers unresolved" — a working setup broken to fix a different
 * one. So the providers are still resolved when they CAN be, and only their
 * absence stops being fatal; a static app with no key degrades exactly where it
 * has to, at a session it could not have served anyway.
 */
export function resolveStaticPageProviders(
  p: Parameters<typeof resolvePipelineProviders>[0],
  env: Record<string, string>,
  logger: Logger,
): ResolvedPipelineProviders | null {
  try {
    return resolvePipelineProviders(p, env);
  } catch (err) {
    logger.debug?.(
      `Static page: no session transport (${errorMessage(err)}). Workflows are unaffected.`,
    );
    return null;
  }
}
