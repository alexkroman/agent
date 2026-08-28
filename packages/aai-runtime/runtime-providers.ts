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

import type { AgentDef } from "@alexkroman1/aai";
import { assertProviderTriple, defaultProviders } from "@alexkroman1/aai/host-internal";
import type { LlmProvider } from "@alexkroman1/aai/llm";
import type { SessionMode } from "@alexkroman1/aai/manifest";
import type { SttProvider } from "@alexkroman1/aai/stt";
import type { TtsProvider } from "@alexkroman1/aai/tts";
import { describeResolvedProviders } from "./providers/_provider-settings.ts";
import type { Logger } from "./runtime-config.ts";
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

/**
 * Report what this runtime resolved, once, at boot.
 *
 * Here rather than in `runtime.ts` because it is a report OF the resolution
 * above it — and because that file is at the line cap, which is where this
 * module came from in the first place.
 *
 * A pipeline agent whose providers fail to reach the runtime does not error —
 * before the pipeline-by-default flip it ran a perfectly healthy S2S session
 * instead — so "which transport is this agent on" has to be answerable from one
 * log line rather than inferred from the shape of the message stream. Each stage
 * reports its EFFECTIVE settings, not just its kind: almost every one is a
 * default nobody wrote down (endpointing window, Voice Focus threshold, gateway
 * model id, TTS voice), and those are the values a misbehaving session gets
 * blamed on. See `_provider-settings.ts`.
 *
 * A WORKFLOW APP gets its own line. A `page: "static"` agent's providers are
 * DEFERRED behind a thunk nobody calls — that deferral is what lets one boot
 * with no credentials at all (`runtime-providers.test.ts`) — so `mode: pipeline`
 * plus a stt/llm/tts settings dump reports three resolutions that did not
 * happen. Observed under `aai dev`: an app with no model and no microphone
 * described itself as an AssemblyAI voice pipeline down to the TTS voice, and
 * six shipped templates are workflow apps. What the line answers for one is "is
 * this durable", which is `sessionState` — the half that is real.
 */
export function logResolvedRuntime(opts: {
  logger: Logger;
  slug: string;
  page: AgentDef["page"];
  providers: ReturnType<typeof resolveEffectiveProviders>;
  sessionState: { backend: string; durable: boolean };
}): void {
  if (opts.page === "static") {
    opts.logger.info("Workflow app resolved", {
      slug: opts.slug,
      sessionState: opts.sessionState,
    });
    return;
  }
  opts.logger.info("Session mode resolved", {
    slug: opts.slug,
    mode: opts.providers.mode,
    ...describeResolvedProviders(opts.providers),
    sessionState: opts.sessionState,
  });
}
