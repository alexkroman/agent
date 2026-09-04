// Copyright 2026 the AAI authors. MIT license.
/**
 * Resolving the three pipeline provider instances — and, more interestingly,
 * deciding WHEN to.
 *
 * Split from `runtime.ts` because the "when" is a policy with a bug behind it,
 * not a line of construction. Resolution is per RUNTIME rather than per session
 * (every session reuses the same opener / LanguageModel — the opener's `open()`
 * mints the per-session stream inside), and credentials come from `providerEnv`
 * like every other provider-facing path: `resolveLlm` throws on a missing key,
 * so resolving from `env` bypassed `withHostCredentialFallback` and killed
 * `aai dev` for pipeline agents on shell-exported keys.
 */

import type { AgentDef } from "@alexkroman1/aai";
import type { LlmProvider } from "@alexkroman1/aai/llm";
import type { SessionMode } from "@alexkroman1/aai/manifest";
import type { SttProvider } from "@alexkroman1/aai/stt";
import type { TtsProvider } from "@alexkroman1/aai/tts";
import { resolveLlm, resolveStt, resolveTts } from "./providers/resolve.ts";
import type { ResolvedPipelineProviders } from "./runtime-transport.ts";

/** The effective providers a runtime resolved for itself, plus its mode. */
type EffectiveProviders = {
  mode: SessionMode;
  stt: SttProvider | undefined;
  llm: LlmProvider | undefined;
  tts: TtsProvider | undefined;
};

/**
 * Resolve the three provider instances. Null unless the mode is pipeline and
 * all three are present.
 */
function resolvePipelineProviders(
  p: EffectiveProviders,
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
 * A memoized resolver, resolved EAGERLY for a voice agent and deferred for a
 * workflow app.
 *
 * Eager is what makes `aai dev` report a missing credential at startup rather
 * than at whatever moment someone first speaks — `resolveLlm` throwing at
 * construction is the whole mechanism.
 *
 * Never for a `page: "static"` agent. That server declines `/websocket` and
 * defaults telephony off, so its providers are the default triple
 * `defaultProviders` injected into an agent that declared none — a credential
 * nothing will ever dial. Resolving it anyway was FATAL: a workflow app with no
 * AssemblyAI key could not boot, dying on "AssemblyAI LLM: missing API key"
 * under `aai dev` and answering 500 on the workflow API of a deployed app whose
 * workflows are fine. (`requiredProviderEnvVars` is the same rule for the
 * preflights; "Workflow apps" in `packages/aai-ui/CLAUDE.md` has the story.)
 *
 * DEFERRED rather than skipped, because one path can still open a session on a
 * static agent — an embedder passing `createRuntimeServer({ telephony: true })` — and
 * it should report the missing key by name rather than the transport factory's
 * "no transport for session", which is what a hardcoded null would produce.
 *
 * @internal
 */
export function createPipelineProviderResolver(opts: {
  agent: Pick<AgentDef, "page">;
  effectiveProviders: EffectiveProviders;
  providerEnv: Record<string, string>;
}): () => ResolvedPipelineProviders | null {
  // Boxed rather than a bare `??=`: `null` is a legitimate resolved value (an
  // S2S agent), and nullish-assignment would re-resolve it on every call.
  let resolved: { value: ResolvedPipelineProviders | null } | undefined;
  const resolve = (): ResolvedPipelineProviders | null => {
    resolved ??= { value: resolvePipelineProviders(opts.effectiveProviders, opts.providerEnv) };
    return resolved.value;
  };
  if (opts.agent.page !== "static") resolve();
  return resolve;
}
